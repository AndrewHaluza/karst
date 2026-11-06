import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ALL_VIEWS, gateGrep, readSettingsSections, selectsLayoutRoute } from './uiViews.mjs';

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
