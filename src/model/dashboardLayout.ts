/**
 * The dashboard page-width preference: one workspace value that every open dashboard tab shares.
 * `centered` caps the page at `--k-content-max` (UI-R48); `full` is the uncapped layout.
 * Host-agnostic: the `vscode` binding (workspaceState) lives in `extension.ts`.
 */
export const DASHBOARD_LAYOUTS = ['centered', 'full'] as const;

export type DashboardLayout = (typeof DASHBOARD_LAYOUTS)[number];

/** A user with no stored value gets the centered page. */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = 'centered';

/** The `workspaceState` key that holds the preference. */
export const DASHBOARD_LAYOUT_KEY = 'karst.dashboardLayout';

/** Narrow an untrusted value (message payload, stored state) to a layout, or `null`. */
export function parseDashboardLayout(value: unknown): DashboardLayout | null {
  return DASHBOARD_LAYOUTS.find((layout) => layout === value) ?? null;
}

/** The stored value when valid, else the default. A corrupt value never reaches the webview. */
export function resolveDashboardLayout(stored: unknown): DashboardLayout {
  return parseDashboardLayout(stored) ?? DEFAULT_DASHBOARD_LAYOUT;
}

/** The dashboard shell carries the default mode on `<body>`; write the stored mode there so the first paint is right. */
export function withDashboardLayout(html: string, layout: DashboardLayout): string {
  return html.replace(`<body data-layout="${DEFAULT_DASHBOARD_LAYOUT}">`, `<body data-layout="${layout}">`);
}
