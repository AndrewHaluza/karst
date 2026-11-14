import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
  ALL_VIEWS,
  LAYOUT_BOOKENDS,
  VIEW_DIRS,
  gateGrep,
  isUiPath,
  readSettingsSections,
  scopedSelection,
  selectDeltaViews,
  selectViews,
  parseListLayout,
  parseListTotal,
  selectionLine,
  selectsLayoutRoute,
} from './uiViews.mjs';

describe('selectViews', () => {
  it('maps a dashboard-only change to the dashboard and status', () => {
    expect(selectViews(['src/ui/dashboard/app/Inside.tsx', 'src/ui/dashboard/state.ts'])).toEqual({
      all: false,
      views: ['dashboard', 'status'],
    });
  });

  it('maps baseline changes to their owning view', () => {
    expect(selectViews(['tests/visual/__baselines__/dark/usage.png'])).toEqual({ all: false, views: ['usage'] });
    expect(selectViews(['tests/visual/__baselines__/dark/dashboard-failed.png'])).toEqual({ all: false, views: ['dashboard', 'status'] });
    expect(selectViews(['tests/visual/__baselines__/dark/status-primitives.png'])).toEqual({ all: false, views: ['status'] });
    expect(selectViews(['tests/visual/__baselines__/dark/agents-profile.png'])).toEqual({ all: false, views: ['settings'] });
  });

  it('maps view-specific visual test files to their owning view', () => {
    expect(selectViews(['tests/visual/panelVariants.ts'])).toEqual({ all: false, views: ['dashboard', 'status'] });
  });

  it('selects every view when the layout ledger changed, so each edited entry is judged', () => {
    expect(selectViews(['tests/visual/__baselines__/dark/usage.png', 'tests/visual/layout-known-failures.json']).all).toBe(true);
    expect(selectViews(['tests/visual/layout-known-failures.json']).all).toBe(true);
  });

  it('counts the layout ledger as a UI path, so an edit after a green pass still runs the gate', () => {
    expect(isUiPath('tests/visual/layout-known-failures.json')).toBe(true);
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

describe('gateGrep layout bookends', () => {
  const setup = 'layout-setup layout.setup.ts clear layout shards';
  const teardown = 'layout-teardown layout.teardown.ts layout ledger verdict';
  const sections = readSettingsSections();

  it.each([...ALL_VIEWS.map((view) => [[view]]), [['dashboard', 'status']], [ALL_VIEWS]])('keeps the setup and teardown titles for %j', (views) => {
    const re = new RegExp(gateGrep({ all: false, views }, sections));
    expect(re.test(setup)).toBe(true);
    expect(re.test(teardown)).toBe(true);
  });
});

describe('selectsLayoutRoute', () => {
  it('is false only when every selected view has no layout route', () => {
    expect(selectsLayoutRoute({ all: false, views: ['catalog'] })).toBe(false);
    expect(selectsLayoutRoute({ all: false, views: ['status'] })).toBe(false);
    expect(selectsLayoutRoute({ all: false, views: ['catalog', 'status'] })).toBe(false);
    expect(selectsLayoutRoute({ all: false, views: ['catalog', 'diffs'] })).toBe(true);
    expect(selectsLayoutRoute({ all: true, views: [] })).toBe(true);
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

  it('states the layout scope with its own counts when known', () => {
    expect(
      selectionLine('test:visual:docker', { all: false, views: ['diffs'] }, { selected: 60, total: 1850, layoutSelected: 25, layoutTotal: 712 }),
    ).toBe('visual: running diffs — 60 of 1,850 tests (25 of 712 layout); full sweep runs in CI');
    expect(
      selectionLine('test:visual:docker', { all: true, views: [] }, { selected: 1850, total: 1850, layoutSelected: 712, layoutTotal: 712 }),
    ).toBe('visual: running every view — 1,850 of 1,850 tests (712 of 712 layout); full sweep also runs in CI');
  });

  it('counts only the layout project in a playwright listing, not its setup and teardown', () => {
    const listing = [
      '  [layout-setup] › layout.setup.ts:8:1 › clear layout shards',
      '  [layout] › layout.layout.ts:62:5 › diffs/empty @1280',
      '  [layout] › layout.layout.ts:62:5 › diffs/empty @900',
      '  [dark] › pages.visual.ts:9:3 › diffs/empty: full-page screenshot',
      '  [layout-teardown] › layout.teardown.ts:90:1 › layout ledger verdict',
    ].join('\n');
    expect(parseListLayout(listing)).toBe(2);
    expect(parseListLayout('boom')).toBe(0);
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

describe('LAYOUT_BOOKENDS', () => {
  it('names the layout setup and teardown titles', () => {
    expect(LAYOUT_BOOKENDS).toEqual(['clear layout shards', 'layout ledger verdict']);
  });
});

describe('selectDeltaViews', () => {
  it('selects no view when the delta holds no UI path', () => {
    expect(selectDeltaViews([])).toEqual({ all: false, views: [] });
    expect(selectDeltaViews(['docs/x.md', 'src/workflow/a.ts', 'src/ui/dashboard/a.test.ts'])).toEqual({ all: false, views: [] });
  });
  it('selects the owning views of the UI paths', () => {
    expect(selectDeltaViews(['src/ui/diffs/a.tsx', 'docs/x.md'])).toEqual({ all: false, views: ['diffs'] });
  });
  it('selects every view for a UI path with no owning view', () => {
    expect(selectDeltaViews(['src/ui/shared/url.ts', 'src/ui/diffs/a.tsx']).all).toBe(true);
  });
});

describe('scopedSelection', () => {
  const since = 'a'.repeat(40);
  const failed = [{ project: 'dark', title: 'sidebar/empty: full-page screenshot' }];
  it('selects the delta views after a green run', () => {
    expect(scopedSelection({ since, paths: ['src/ui/diffs/a.tsx'], failed: [] })).toEqual({
      selection: { all: false, views: ['diffs'] },
      failed: [],
      origin: { kind: 'green', since, failed: 0 },
    });
  });
  it('carries the failed tests of a red run with no UI path in the delta', () => {
    expect(scopedSelection({ since, paths: ['docs/x.md'], failed })).toEqual({
      selection: { all: false, views: [] },
      failed,
      origin: { kind: 'red', since, failed: 1 },
    });
  });
  it('selects every view and carries no failed test for a shared path', () => {
    expect(scopedSelection({ since, paths: ['src/ui/shared/url.ts'], failed })).toEqual({
      selection: { all: true, views: ALL_VIEWS },
      failed: [],
      origin: { kind: 'red', since, failed: 0 },
    });
  });
  it('is null when it selects nothing', () => {
    expect(scopedSelection({ since, paths: ['docs/x.md'], failed: [] })).toBeNull();
  });
});

describe('gateGrep with failed tests', () => {
  const sections = readSettingsSections();
  it('matches the failed titles and keeps the bookends', () => {
    const re = new RegExp(gateGrep({ all: false, views: [] }, sections, [{ project: 'dark', title: 'sidebar/empty: full-page screenshot' }]));
    expect(re.test('dark tests/visual/pages.visual.ts full-page screenshots sidebar/empty: full-page screenshot')).toBe(true);
    expect(re.test('dark tests/visual/pages.visual.ts full-page screenshots usage/empty: full-page screenshot')).toBe(false);
    expect(re.test('layout-teardown layout.teardown.ts layout ledger verdict')).toBe(true);
    expect(re.test('layout-setup layout.setup.ts clear layout shards')).toBe(true);
  });
  it('adds the failed titles to the view tokens', () => {
    const re = new RegExp(gateGrep({ all: false, views: ['diffs'] }, sections, [{ project: 'dark', title: 'usage/busy: full-page screenshot' }]));
    expect(re.test('dark pages.visual.ts diffs/empty: full-page screenshot')).toBe(true);
    expect(re.test('dark pages.visual.ts usage/busy: full-page screenshot')).toBe(true);
    expect(re.test('dark pages.visual.ts sidebar/empty: full-page screenshot')).toBe(false);
  });
  it('escapes the regex characters of a title', () => {
    const re = new RegExp(gateGrep({ all: false, views: [] }, sections, [{ project: 'layout', title: 'agents#tab=roles (x) @1280' }]));
    expect(re.test('layout layout.layout.ts agents#tab=roles (x) @1280')).toBe(true);
    expect(re.test('layout layout.layout.ts agents#tab=roles x @1280')).toBe(false);
  });
  it('is null with no view and no failed test', () => {
    expect(gateGrep({ all: false, views: [] }, sections, [])).toBeNull();
  });
});

describe('selectionLine with an origin', () => {
  const since = 'a'.repeat(40);
  it('names the green run for a delta selection', () => {
    expect(selectionLine('test:visual:docker', { all: false, views: ['diffs'] }, { selected: 60, total: 1850 }, { kind: 'green', since, failed: 0 })).toBe(
      'visual: running diffs (changed since the green run at aaaaaaaaaaaa) — 60 of 1,850 tests; full sweep runs in CI',
    );
  });
  it('names the red run and its failed tests', () => {
    expect(selectionLine('test:visual:docker', { all: false, views: ['settings'] }, null, { kind: 'red', since, failed: 2 })).toBe(
      'visual: running settings (changed since the red run at aaaaaaaaaaaa) and 2 failed tests of that run; full sweep runs in CI',
    );
    expect(selectionLine('test:layout:docker', { all: false, views: [] }, null, { kind: 'red', since, failed: 1 })).toBe(
      'layout: running 1 failed test of the red run at aaaaaaaaaaaa; full sweep runs in CI',
    );
  });
  it('keeps the every-view line', () => {
    expect(selectionLine('test:visual:docker', { all: true, views: [] }, null, { kind: 'red', since, failed: 0 })).toBe(
      'visual: running every view; full sweep also runs in CI',
    );
  });
});
