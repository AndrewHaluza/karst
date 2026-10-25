/**
 * Transitional seam between the React Servers panel and the vanilla page script (removed in
 * migration Phase 12, with the rest of the vanilla script). React never writes
 * `vscode.setState` and never reaches into vanilla functions, so the three things that still
 * live in `webview.html` are announced as window events the page script listens for:
 * the services filter (vanilla persists it), and the two local surfaces the header opens.
 */
export const SRV_FILTER_EVENT = 'karst:srvFilter';
export const OPEN_SERVER_LOGS_EVENT = 'karst:openServerLogs';
export const OPEN_ENV_OVERRIDES_EVENT = 'karst:openEnvOverrides';

export function announceFilter(value: string): void {
  window.dispatchEvent(new CustomEvent<string>(SRV_FILTER_EVENT, { detail: value }));
}

export function announce(name: typeof OPEN_SERVER_LOGS_EVENT | typeof OPEN_ENV_OVERRIDES_EVENT): void {
  window.dispatchEvent(new CustomEvent(name));
}
