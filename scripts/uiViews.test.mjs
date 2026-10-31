import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
  ALL_VIEWS,
  VIEW_DIRS,
  gateGrep,
  readSettingsSections,
  selectViews,
  parseListTotal,
  selectionLine,
} from './uiViews.mjs';

describe('selectViews', () => {
  it('maps a dashboard-only change to the dashboard and status', () => {
    expect(selectViews(['src/ui/dashboard/app/Inside.tsx', 'src/ui/dashboard/state.ts'])).toEqual({
      all: false,
      views: ['dashboard', 'status'],
    });
  });

  it('maps baseline changes to their owning view and ignores layout-known-failures.json', () => {
    expect(selectViews(['tests/visual/__baselines__/dark/usage.png', 'tests/visual/layout-known-failures.json'])).toEqual({
      all: false,
      views: ['usage'],
    });
  });

  it('unions the views of several directories', () => {
    expect(selectViews(['src/ui/sidebar/items.ts', 'src/ui/usage/state.ts']).views).toEqual(['sidebar', 'usage']);
  });

  it('selects every view for a theme or shared css change', () => {
    expect(selectViews(['src/model/designComponents.webview.css']).all).toBe(true);
    expect(selectViews(['src/ui/dashboard/app/Inside.tsx', 'src/theme/colors.ts']).all).toBe(true);
  });

  it('selects every view for an unmapped UI file (fail safe)', () => {
    expect(selectViews(['src/ui/shared/url.ts']).all).toBe(true);
    expect(selectViews(['src/ui/session.ts']).all).toBe(true);
    expect(selectViews(['tests/visual/fixtures.ts']).all).toBe(true);
    expect(selectViews(['playwright.config.ts']).all).toBe(true);
  });

  it('ignores unit tests and non-UI paths, and runs everything when nothing is left', () => {
    expect(selectViews(['src/ui/dashboard/state.test.ts', 'src/ui/sidebar/items.ts']).views).toEqual(['sidebar']);
    expect(selectViews(['src/workflow/gates/x.ts', 'src/ui/sidebar/items.ts']).views).toEqual(['sidebar']);
    expect(selectViews(['src/ui/dashboard/state.test.ts']).all).toBe(true);
    expect(selectViews([]).all).toBe(true);
  });
});

describe('the map', () => {
  it('resolves every view that has baselines from a source path', () => {
    const baselineDir = 'tests/visual/__baselines__';
    const names = new Set();
    for (const project of readdirSync(baselineDir)) {
      for (const file of readdirSync(`${baselineDir}/${project}`)) names.add(file.replace(/\.png$/, '').split(/--|-(?=[a-z]+$)/)[0]);
    }
    const resolvable = new Set(Object.values(VIEW_DIRS).flat());
    for (const name of names) {
      const view = name === 'status' ? 'status' : name.replace(/-.*$/, '');
      if (view === 'catalog' || view === 'agents') continue; // standalone page; agents baselines are the settings view
      expect(resolvable.has(view), `${name} has no source path`).toBe(true);
    }
    for (const view of ALL_VIEWS) expect(Boolean(view)).toBe(true);
  });

  it('only names directories that exist', () => {
    for (const dir of Object.keys(VIEW_DIRS)) expect(() => readdirSync(`src/ui/${dir}`)).not.toThrow();
  });
});

describe('gateGrep', () => {
  const sections = readSettingsSections();

  it('reads the settings sections from source', () => {
    expect(sections).toContain('general');
    expect(sections.length).toBeGreaterThan(3);
  });

  it('is null for the full sweep', () => {
    expect(gateGrep({ all: true, views: ALL_VIEWS }, sections)).toBeNull();
  });

  it('matches view titles, status, and always keeps the layout bookends', () => {
    const re = new RegExp(gateGrep(selectViews(['src/ui/dashboard/panel.ts']), sections));
    expect(re.test('dark tests/visual/pages.visual.ts full-page screenshots dashboard/running: full-page screenshot')).toBe(true);
    expect(re.test('dark status.visual.ts status primitives: full-page screenshot')).toBe(true);
    expect(re.test('layout layout.layout.ts dashboard/running @480')).toBe(true);
    expect(re.test('layout layout.teardown.ts layout ledger verdict')).toBe(true);
    expect(re.test('layout layout.setup.ts clear layout shards')).toBe(true);
    expect(re.test('dark pages.visual.ts sidebar/empty: full-page screenshot')).toBe(false);
    expect(re.test('layout layout.layout.ts general @480')).toBe(false);
  });

  it('selects settings layout routes by section id', () => {
    const re = new RegExp(gateGrep(selectViews(['src/ui/settings/state.ts']), sections));
    expect(re.test('layout layout.layout.ts general @480')).toBe(true);
    expect(re.test('layout layout.layout.ts agents#tab=roles @1280')).toBe(true);
    expect(re.test('dark pages.visual.ts settings/default: full-page screenshot')).toBe(true);
  });
});

describe('selectionLine', () => {
  it('names the views and the CI backstop', () => {
    expect(selectionLine('test:visual:docker', { all: false, views: ['dashboard', 'status'] })).toBe(
      'visual: running dashboard, status; full sweep runs in CI',
    );
    expect(selectionLine('test:layout:docker', { all: true, views: [] })).toContain('every view');
  });

  it('adds the test counts when known', () => {
    expect(selectionLine('test:visual:docker', { all: false, views: ['dashboard'] }, { selected: 212, total: 1850 })).toBe(
      'visual: running dashboard — 212 of 1,850 tests; full sweep runs in CI',
    );
  });

  it('reads the total from a playwright listing', () => {
    expect(parseListTotal('a\nTotal: 691 tests in 11 files\n')).toBe(691);
    expect(parseListTotal('boom')).toBeNull();
  });
});

it('keeps package.json passing KARST_UI_GREP into the gate and update containers', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
  expect(scripts['test:visual:docker']).toContain('-e KARST_UI_GREP');
  expect(scripts['test:layout:docker']).toContain('-e KARST_UI_GREP');
  expect(scripts['test:visual:docker:update']).toContain('-e KARST_UI_GREP');
});
