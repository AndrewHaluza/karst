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

const VIEW_DIR_PATH = /^src\/ui\/([^/]+)\/(.+)$/;

/**
 * `{ all: true }` or `{ all: false, views }` (views sorted, possibly empty when
 * the diff holds no UI path at all).
 */
export function selectViews(changedPaths) {
  const views = new Set();
  let sawUi = false;
  for (const path of changedPaths) {
    if (!UI_PATH.some((p) => p.test(path))) continue;
    if (TEST_FILE.test(path)) continue;
    sawUi = true;
    const match = VIEW_DIR_PATH.exec(path);
    const owned = match ? VIEW_DIRS[match[1]] : undefined;
    if (owned === undefined) return { all: true, views: ALL_VIEWS };
    for (const view of owned) views.add(view);
  }
  if (!sawUi) return { all: true, views: ALL_VIEWS };
  return { all: false, views: [...views].sort() };
}

/** `SETTINGS_SECTIONS` read from source: layout titles for settings are the bare section ids. */
export function readSettingsSections(repo = process.cwd()) {
  const source = readFileSync(join(repo, 'src/ui/settings/sections.ts'), 'utf8');
  const body = /SETTINGS_SECTIONS\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Layout setup/teardown must always run, or the ledger verdict is lost. */
const LAYOUT_BOOKENDS = ['clear layout shards', 'layout ledger verdict'];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The Playwright grep (a RegExp source) for a selection, or null for the full
 * sweep. Matches titles `<view>/…`, `<view>: …`, the status and catalog
 * screenshots, and the settings layout routes (bare section ids).
 */
export function gateGrep(selection, settingsSections) {
  if (selection.all) return null;
  const tokens = [];
  for (const view of selection.views) {
    if (view === 'status') tokens.push('status primitives');
    else if (view === 'catalog') tokens.push('catalog:');
    else tokens.push(`${escape(view)}[/:]`);
    if (view === 'settings') for (const s of settingsSections) tokens.push(`${escape(s)}[ #]`);
  }
  const head = `(?:^|\\s)(?:${tokens.join('|')})`;
  return `${head}|${LAYOUT_BOOKENDS.join('|')}`;
}

/** The line printed at the top of the gate output. */
export function selectionLine(script, selection, counts = null) {
  const name = script.replace(/^test:/, '').replace(/:docker$/, '');
  const tests = counts ? ` — ${counts.selected.toLocaleString('en-US')} of ${counts.total.toLocaleString('en-US')} tests` : '';
  if (selection.all) return `${name}: running every view${tests}; full sweep also runs in CI`;
  return `${name}: running ${selection.views.join(', ')}${tests}; full sweep runs in CI`;
}

/** The N in playwright's `Total: N tests in M files`, or null when the listing is unreadable. */
export function parseListTotal(output) {
  const match = /Total: (\d+) tests?/.exec(output);
  return match ? Number(match[1]) : null;
}
