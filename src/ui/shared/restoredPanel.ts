/**
 * A webview panel that VS Code restored after a window reload (the
 * `WebviewPanelSerializer` path). It is not yet wrapped: a manager decides first
 * whether to adopt it, and only then calls `wrap()` — which sets the html, the
 * icon and the options. A panel that is not adopted is disposed with `dispose()`
 * and never gets a document.
 */
export interface RestoredPanel<P> {
  /** Configure the raw panel exactly as a new one and return the manager-facing wrapper. */
  wrap(): P;
  /** Close the raw panel without wrapping it. */
  dispose(): void;
}

/** Read the ticket id from the `karstPanel` identity key of a restored webview state. */
export function restoredTicketId(state: unknown): number | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const identity = (state as { karstPanel?: unknown }).karstPanel;
  if (typeof identity !== 'object' || identity === null) return undefined;
  const id = (identity as { ticketId?: unknown }).ticketId;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined;
}

