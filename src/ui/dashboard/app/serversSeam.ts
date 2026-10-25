/**
 * Transitional seam between the React Servers panel and the vanilla page script (removed in
 * migration Phase 12, with the rest of the vanilla script). React never writes
 * `vscode.setState`, so the services filter, which the page persists, is announced as a window event the
 * page script listens for. (The header's Logs and Env buttons open overlay views, which are React's now.)
 */
export const SRV_FILTER_EVENT = 'karst:srvFilter';

export function announceFilter(value: string): void {
  window.dispatchEvent(new CustomEvent<string>(SRV_FILTER_EVENT, { detail: value }));
}
