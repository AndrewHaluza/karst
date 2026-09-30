/**
 * Browser-safe home of `DEFAULT_START_STATUS`.
 *
 * The webview needs the same constant the start stage uses, and it cannot import
 * from `start.ts`: that module reaches `store/db.js` (better-sqlite3), which is
 * host-only and cannot be bundled into a webview asset. So the constant lives
 * here and `start.ts` re-exports it — one definition, two importers, and no
 * mirrored literal in the webview (UI-R34 / NDL-126 R-X1, "import, never
 * mirror").
 *
 * This module must stay dependency-free: it is imported from the settings
 * bundle, so anything it pulls in ends up there too.
 */

/**
 * Fallback status name pushed when `advanceOnStart` is on but `startStatus` was
 * left blank or unset — most trackers ship a status with this exact name, so an
 * incomplete config still does something useful instead of silently no-op'ing.
 */
export const DEFAULT_START_STATUS = 'in progress';