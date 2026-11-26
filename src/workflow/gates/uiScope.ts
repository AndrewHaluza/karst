/**
 * The paths whose change can alter what the visual/layout gates render. A
 * ticket whose diff touches none of them has nothing for those gates to say;
 * CI still runs the full sweep as the backstop for a backend change that
 * alters a fixture. Host-built text a webview shows (the built-in prompts of the
 * Settings page) is covered by a committed snapshot under `src/ui/settings/`,
 * which is a UI path; CI stays the backstop for other host data.
 */
export const UI_PATH_PATTERNS: readonly RegExp[] = [
  /^src\/ui\//,
  /^tests\/visual\//,
  /^playwright\.config\.ts$/,
  /^package-lock\.json$/,
  /\.css$/,
  /(^|\/)theme\//,
];

/** The npm scripts of the container-pinned gates the UI set guards. */
export const UI_GATE_SCRIPTS: readonly string[] = ['test:visual:docker', 'test:layout:docker'];

/** The reason a UI gate records when the diff holds no UI path. */
export const NO_UI_CHANGE_REASON = 'no UI change';

/** Visual files that render nothing (`scripts/uiViews.mjs` keeps the same list): sweepBudget.ts holds the sweep counts, and only sweepBudget.test.ts in the unit gate reads it. */
export const NON_RENDERING_VISUAL_PATHS: readonly string[] = ['tests/visual/sweepBudget.ts'];

export function matchesUiPath(path: string): boolean {
  if (NON_RENDERING_VISUAL_PATHS.includes(path)) return false;
  return UI_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function hasUiChange(changedPaths: readonly string[]): boolean {
  return changedPaths.some(matchesUiPath);
}

export function isUiGate(gate: { script: string | null }): boolean {
  return gate.script !== null && UI_GATE_SCRIPTS.includes(gate.script);
}
