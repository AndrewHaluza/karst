/** VS Code addresses at most nine editor groups by number. */
export const MAX_VIEW_COLUMN = 9;

/**
 * The editor group a ticket diff opens in, given the column of the changes
 * panel that requested it.
 *
 * The host used to pass `ViewColumn.Beside`, which resolves against whichever
 * group is ACTIVE when the command runs — and a webview's click reaches the
 * extension host before VS Code has finished making that webview's own group
 * active again. With the previously opened diff still active, "beside" meant
 * "one further right", so every click stacked another editor group. Anchoring
 * on the REQUESTING panel's column instead names the same group every time, so
 * repeated clicks reuse one diff group.
 *
 * `undefined` means "no opinion" — the panel is hidden and has no column, so
 * the host falls back to its own default.
 */
export function diffViewColumn(panelColumn: number | undefined): number | undefined {
  if (typeof panelColumn !== 'number' || !Number.isFinite(panelColumn)) return undefined;
  const column = Math.floor(panelColumn);
  if (column < 1) return undefined;
  return Math.min(column + 1, MAX_VIEW_COLUMN);
}
