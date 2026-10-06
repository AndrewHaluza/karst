/**
 * Resolve which edge of the sidebar webview draws the 1px resize line
 * (SIDEBAR-SUPER-THIN-EDGE-LINE-SO).
 *
 * VS Code owns the sidebar border and the sash, but a theme with a transparent
 * `sideBar.border` leaves the drag handle invisible. Karst paints its own
 * super-thin line INSIDE the webview on the side that faces the editor.
 *
 * A webview cannot detect whether it is docked in the primary or secondary
 * sidebar, so `auto` assumes the primary sidebar and takes the edge OPPOSITE
 * `workbench.sideBar.location`. The `left`/`right`/`none` values of the
 * `karst.sidebar.edge` setting override that guess.
 *
 * Pure and vscode-free: `extension.ts` reads the two settings and calls this.
 */

/** The `karst.sidebar.edge` setting values. */
export type SidebarEdgeSetting = 'auto' | 'left' | 'right' | 'none';

/** The resolved edge line: which side of the view faces the editor. */
export type SidebarEdge = 'left' | 'right' | 'none';

/** `workbench.sideBar.location` — the only two docked locations VS Code offers. */
export type SideBarLocation = 'left' | 'right';

/** Coerce an untrusted setting value to a known enum member (default `auto`). */
export function normalizeEdgeSetting(value: unknown): SidebarEdgeSetting {
  return value === 'left' || value === 'right' || value === 'none' ? value : 'auto';
}

/**
 * Resolve the edge line side from the setting and the sidebar location.
 *
 * - `none`  → no line.
 * - `left` / `right` → that side, regardless of location.
 * - `auto` (default) → the edge opposite the sidebar, i.e. the one facing the
 *   editor: a primary sidebar on the left shows its line on the right.
 *   An unknown/missing location falls back to `left` (VS Code's default).
 */
export function resolveSidebarEdge(
  setting: unknown,
  location: unknown,
): SidebarEdge {
  const s = normalizeEdgeSetting(setting);
  if (s === 'none') return 'none';
  if (s === 'left') return 'left';
  if (s === 'right') return 'right';
  return location === 'right' ? 'left' : 'right';
}
