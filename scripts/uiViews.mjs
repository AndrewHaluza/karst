// Which views can a ticket's changed files reach? The local visual/layout gates
// run only those; CI keeps the full sweep. Unknown means full (fail safe).
//
// The map is by directory, not by module graph: each webview owns
// `src/ui/<dir>/`, and everything else UI-shaped (shared components, theme,
// CSS, the harness, the config) is a shared root that selects every view.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Webview directory under src/ui/ -> the view ids its change can alter. */
export const VIEW_DIRS = {
  dashboard: ['dashboard', 'status'],
  diffs: ['diffs'],
  gettingStarted: ['gettingStarted'],
  resources: ['resources'],
  serverLogs: ['serverLogs'],
  settings: ['settings'],
  sidebar: ['sidebar'],
  ticketForm: ['ticketForm'],
  usage: ['usage'],
};

/** Every view id the sweep covers (`catalog` is a standalone page, no src dir). */
export const ALL_VIEWS = [...new Set(Object.values(VIEW_DIRS).flat()), 'catalog'];

/** Paths whose change can alter a render (mirrors src/workflow/gates/uiScope.ts). */
const UI_PATH = [/^src\/ui\//, /^tests\/visual\//, /^playwright\.config\.ts$/, /^package-lock\.json$/, /\.css$/, /(^|\/)theme\//];

/** A unit test never renders. */
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Files under tests/visual/ with a single owning view (e.g. panel variant definitions). */
export const VIEW_FILES = {
  'tests/visual/panelVariants.ts': 'dashboard',
};

const VIEW_DIR_PATH = /^src\/ui\/([^/]+)\/(.+)$/;
const BASELINE_PATH = /^tests\/visual\/__baselines__\/[^/]+\/([a-zA-Z0-9]+?)(?:--|-.*)?\.png$/;

/** Whether a changed path can alter a render: the paths `selectViews` counts as UI. */
export const isUiPath = (path) => UI_PATH.some((p) => p.test(path)) && !TEST_FILE.test(path);

/**
 * `{ all: true }` or `{ all: false, views }` (views sorted, possibly empty when
 * the diff holds no UI path at all).
 */
export function selectViews(changedPaths) {
  const views = new Set();
  let sawUi = false;
  for (const path of changedPaths) {
    if (!isUiPath(path)) continue;
    sawUi = true;
    // A path with no owning view selects every view. That includes the layout ledger:
    // an edited entry can name any route, and only the full chain judges each entry.
    const fileOwned = VIEW_FILES[path];
    const match = fileOwned ? null : VIEW_DIR_PATH.exec(path) ?? BASELINE_PATH.exec(path);
    const rawName = fileOwned ?? (match ? match[1] : undefined);
    const viewName = rawName === 'agents' ? 'settings' : rawName;
    const owned = viewName ? (VIEW_DIRS[viewName] ?? (ALL_VIEWS.includes(viewName) ? [viewName] : undefined)) : undefined;
    if (owned === undefined) return { all: true, views: ALL_VIEWS };
    for (const view of owned) views.add(view);
  }
  if (!sawUi) return { all: true, views: ALL_VIEWS };
  return { all: false, views: [...views].sort() };
}

/**
 * The views of a repeat-pass delta (@arch:GATE-REPEAT). Unlike `selectViews`, a delta with no UI path
 * selects no view: the stored run already covered the views.
 */
export function selectDeltaViews(paths) {
  const ui = paths.filter(isUiPath);
  return ui.length === 0 ? { all: false, views: [] } : selectViews(ui);
}

/**
 * The selection of a repeat pass from the stored run (@arch:GATE-REPEAT): the views of the delta since its
 * snapshot plus its failed tests. `scope` is `{ since, paths, failed }` from `planRepeat`. Null when it
 * selects nothing; the caller then uses the branch diff.
 */
export function scopedSelection({ since, paths, failed }) {
  const selection = selectDeltaViews(paths);
  const carried = selection.all ? [] : failed;
  if (!selection.all && selection.views.length === 0 && carried.length === 0) return null;
  return { selection, failed: carried, origin: { kind: failed.length > 0 ? 'red' : 'green', since, failed: carried.length } };
}

/** `SETTINGS_SECTIONS` read from source: layout titles for settings are the bare section ids. */
export function readSettingsSections(repo = process.cwd()) {
  const source = readFileSync(join(repo, 'src/ui/settings/sections.ts'), 'utf8');
  const body = /SETTINGS_SECTIONS\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Views with screenshots but no layout route (uiViews.integration.test.mjs pins this against the real listing). */
const VIEWS_WITHOUT_LAYOUT = ['catalog', 'status'];

/** Whether a selection reaches at least one layout route. */
export const selectsLayoutRoute = (selection) => selection.all || selection.views.some((view) => !VIEWS_WITHOUT_LAYOUT.includes(view));

/** Layout setup/teardown must always run, or the ledger verdict is lost. */
export const LAYOUT_BOOKENDS = ['clear layout shards', 'layout ledger verdict'];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The Playwright grep (a RegExp source) for a selection, or null for the full
 * sweep. Matches titles `<view>/…`, `<view>: …`, the status and catalog
 * screenshots, the settings layout routes (bare section ids), and the titles of
 * `failed` (`{ project, title }`, the failed tests of a stored red run).
 * Null also when nothing is selected.
 */
export function gateGrep(selection, settingsSections, failed = []) {
  if (selection.all) return null;
  const tokens = [];
  for (const view of selection.views) {
    if (view === 'status') tokens.push('status primitives');
    else if (view === 'catalog') tokens.push('catalog:');
    else tokens.push(`${escape(view)}[/:]`);
    if (view === 'settings') for (const s of settingsSections) tokens.push(`${escape(s)}[ #]`);
  }
  for (const title of new Set(failed.map((f) => f.title))) tokens.push(escape(title));
  if (tokens.length === 0) return null;
  const head = `(?:^|\\s)(?:${tokens.join('|')})`;
  return `${head}|${LAYOUT_BOOKENDS.join('|')}`;
}

const failedCount = (n) => `${n} failed test${n === 1 ? '' : 's'}`;

/** What a repeat-pass selection runs, with the stored run it comes from. */
function scopedWhat(views, { kind, since, failed }) {
  const at = `the ${kind} run at ${since.slice(0, 12)}`;
  const changed = views.length > 0 ? `${views.join(', ')} (changed since ${at})` : '';
  if (failed === 0) return changed;
  return changed ? `${changed} and ${failedCount(failed)} of that run` : `${failedCount(failed)} of ${at}`;
}

/**
 * The line printed at the top of the gate output. `origin` (`{ kind: 'green' | 'red', since, failed }`,
 * from `scopedSelection`) names the stored run of a repeat-pass selection; null for the branch diff.
 */
export function selectionLine(script, selection, counts = null, origin = null) {
  const name = script.replace(/^test:/, '').replace(/:docker$/, '');
  const count = (n) => n.toLocaleString('en-US');
  const layout = counts?.layoutTotal === undefined ? '' : ` (${count(counts.layoutSelected)} of ${count(counts.layoutTotal)} layout)`;
  const tests = counts ? ` — ${count(counts.selected)} of ${count(counts.total)} tests${layout}` : '';
  if (selection.all) return `${name}: running every view${tests}; full sweep also runs in CI`;
  const what = origin === null ? selection.views.join(', ') : scopedWhat(selection.views, origin);
  return `${name}: running ${what}${tests}; full sweep runs in CI`;
}

/** The N in playwright's `Total: N tests in M files`, or null when the listing is unreadable. */
export function parseListTotal(output) {
  const match = /Total: (\d+) tests?/.exec(output);
  return match ? Number(match[1]) : null;
}

/** How many `layout` project tests a playwright listing holds (the setup and teardown projects do not count). */
export function parseListLayout(output) {
  return output.match(/^\s*\[layout\] ›/gm)?.length ?? 0;
}
