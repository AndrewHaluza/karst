import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ALL_VIEWS, fixtureViews, gateGrep, readSettingsSections, selectsLayoutRoute } from './uiViews.mjs';

/** The real listing for a grep: test titles per layout project. */
function listLayout(grep, args = []) {
  const run = spawnSync('npx', ['playwright', 'test', '--list', ...args], {
    encoding: 'utf8',
    env: { ...process.env, KARST_UI_GREP: grep },
  });
  expect(run.status, run.stderr).toBe(0);
  const titles = { 'layout-setup': [], layout: [], 'layout-teardown': [] };
  for (const line of run.stdout.split('\n')) {
    const match = /^\s*\[(layout[a-z-]*)\] › \S+ › (.*)$/.exec(line);
    if (match) titles[match[1]].push(match[2]);
  }
  return titles;
}

const sections = readSettingsSections();
const LAYOUT_ROUTE_PREFIX = {
  dashboard: /^dashboard\//,
  status: /^$/,
  diffs: /^diffs\//,
  gettingStarted: /^gettingStarted\//,
  resources: /^resources\//,
  serverLogs: /^serverLogs\//,
  settings: new RegExp(`^(?:settings/|(?:${sections.join('|')})[ #])`),
  sidebar: /^sidebar\//,
  ticketForm: /^ticketForm\//,
  usage: /^usage\//,
  catalog: /^$/,
};

describe('a hand-written KARST_UI_GREP', () => {
  it.each([[[]], [['--project=layout']]])('keeps the setup and teardown tests with args %j', (args) => {
    const titles = listLayout('diffs/empty', args);
    expect(titles['layout-setup']).toEqual(['clear layout shards']);
    expect(titles['layout-teardown']).toEqual(['layout ledger verdict']);
    expect(titles.layout.length).toBeGreaterThan(0);
  });
});

describe('gateGrep against the real playwright listing', () => {
  const all = listLayout('').layout;

  it('has a route rule for each view, and the full listing holds every route', () => {
    expect(Object.keys(LAYOUT_ROUTE_PREFIX).sort()).toEqual([...ALL_VIEWS].sort());
    expect(all.filter((title) => !Object.values(LAYOUT_ROUTE_PREFIX).some((rule) => rule.test(title)))).toEqual([]);
  });

  it.each(ALL_VIEWS)('selects one setup, one teardown and exactly the layout routes of %s', (view) => {
    const selection = { all: false, views: [view] };
    const titles = listLayout(gateGrep(selection, sections));
    expect(titles['layout-setup']).toEqual(['clear layout shards']);
    expect(titles['layout-teardown']).toEqual(['layout ledger verdict']);
    expect(titles.layout).toEqual(all.filter((title) => LAYOUT_ROUTE_PREFIX[view].test(title)));
    expect(titles.layout.length > 0).toBe(selectsLayoutRoute(selection));
  });
});

/** The real JSON listing for a grep: `{ file, title }` of each test, where `title` is the test's own title. */
function listTests(grep) {
  const run = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
    encoding: 'utf8',
    env: { ...process.env, KARST_UI_GREP: grep },
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(run.status, run.stderr).toBe(0);
  const tests = [];
  const walk = (suite, file) => {
    const at = suite.file ?? file;
    for (const spec of suite.specs ?? []) tests.push({ file: at, title: spec.title });
    for (const child of suite.suites ?? []) walk(child, at);
  };
  for (const suite of JSON.parse(run.stdout).suites) walk(suite, suite.file);
  return tests;
}

const prefixOf = (title) => /^[^/:]+/.exec(title)?.[0] ?? '';
const SETTINGS_LAYOUT_ROUTE = new RegExp(`^(?:${sections.join('|')})[ #]`);

/**
 * The fixture view whose pages a listed test loads, by spec file. `null`: the test loads no fixture view page
 * (catalog.html is always written). A spec file that is not in the map fails the test, so that a new spec
 * cannot load a page that a scoped write leaves out.
 */
const PAGE_VIEW_OF_FILE = {
  'pages.visual.ts': prefixOf,
  'a11y.visual.ts': prefixOf,
  'focus.visual.ts': prefixOf,
  'contentCap.visual.ts': prefixOf,
  'layout.layout.ts': (title) => (SETTINGS_LAYOUT_ROUTE.test(title) ? 'settings' : /^[^/]+/.exec(title)?.[0] ?? ''),
  'status.visual.ts': () => 'dashboard',
  'stagePalette.visual.ts': () => 'dashboard',
  'subtasks.visual.ts': () => 'dashboard',
  // Every test in the sidebar spec opens a sidebar page, whatever its own title says.
  'sidebar.visual.ts': () => 'sidebar',
  'catalog.visual.ts': () => null,
  'buildFixture.visual.ts': () => null,
  'corpora.visual.ts': () => null,
  'chains.test-shape.visual.ts': () => null,
  'coverage.visual.ts': () => null,
  'themes.visual.ts': () => null,
  'servers.visual.ts': () => null,
  'layout.setup.ts': () => null,
  'layout.teardown.ts': () => null,
};

describe('fixture views of a scoped run (@ui:FIXTURE-SCOPE)', () => {
  it.each(ALL_VIEWS)('writes every page that the %s-scoped run loads', (view) => {
    const selection = { all: false, views: [view] };
    const written = fixtureViews(selection, []);
    const missing = new Set();
    for (const { file, title } of listTests(gateGrep(selection, sections))) {
      const pageView = PAGE_VIEW_OF_FILE[file];
      expect(pageView, `add ${file} to the fixture-view map`).toBeDefined();
      const loaded = pageView(title);
      if (loaded !== null && written !== null && !written.split(',').includes(loaded)) missing.add(`${file}: ${title} -> ${loaded}`);
    }
    expect([...missing]).toEqual([]);
  });
});
