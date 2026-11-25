import { describe, expect, it } from 'vitest';
import { ALL_VIEWS } from './corpora.js';
import { FIXTURE_VIEWS_ENV, fixtureViewsFromEnv, missingFixtureMessage } from './fixtureScope.js';

describe('missingFixtureMessage', () => {
  const path = '/dark/dashboard--pending.html';

  it('gives null for a page that the server has', () => {
    expect(missingFixtureMessage({ path, status: 200, env: { KARST_VISUAL_FIXTURE_VIEWS: 'settings' } })).toBeNull();
    expect(missingFixtureMessage({ path, status: null, env: {} })).toBeNull();
  });

  it('names the path, the view list and the repair when a scoped write left out the page', () => {
    const message = missingFixtureMessage({ path, status: 404, env: { KARST_VISUAL_FIXTURE_VIEWS: 'settings' } });
    expect(message).toContain(path);
    expect(message).toContain('KARST_VISUAL_FIXTURE_VIEWS=settings');
    expect(message).toContain('add the view to fixtureViews in scripts/uiViews.mjs, or unset KARST_VISUAL_FIXTURE_VIEWS');
  });

  it('says that the fixture writer wrote no such page when the write was not scoped', () => {
    for (const env of [{}, { KARST_VISUAL_FIXTURE_VIEWS: '' }]) {
      const message = missingFixtureMessage({ path, status: 404, env });
      expect(message).toContain(path);
      expect(message).toContain('the fixture writer wrote no such page');
      expect(message).not.toContain('fixtureViews in scripts/uiViews.mjs');
    }
  });
});

describe('fixtureViewsFromEnv', () => {
  it('reads KARST_VISUAL_FIXTURE_VIEWS', () => {
    expect(FIXTURE_VIEWS_ENV).toBe('KARST_VISUAL_FIXTURE_VIEWS');
  });

  it('gives every view when the variable is unset or empty', () => {
    expect(fixtureViewsFromEnv({})).toEqual({ views: ALL_VIEWS, warning: null });
    expect(fixtureViewsFromEnv({ KARST_VISUAL_FIXTURE_VIEWS: '' })).toEqual({ views: ALL_VIEWS, warning: null });
  });

  it('gives the listed views', () => {
    expect(fixtureViewsFromEnv({ KARST_VISUAL_FIXTURE_VIEWS: 'settings' })).toEqual({ views: ['settings'], warning: null });
    expect(fixtureViewsFromEnv({ KARST_VISUAL_FIXTURE_VIEWS: 'dashboard,sidebar' })).toEqual({
      views: ['dashboard', 'sidebar'],
      warning: null,
    });
  });

  it('drops spaces and empty items', () => {
    expect(fixtureViewsFromEnv({ KARST_VISUAL_FIXTURE_VIEWS: ' dashboard, ,sidebar ,' })).toEqual({
      views: ['dashboard', 'sidebar'],
      warning: null,
    });
    expect(fixtureViewsFromEnv({ KARST_VISUAL_FIXTURE_VIEWS: ' , ' })).toEqual({ views: ALL_VIEWS, warning: null });
  });

  it('gives every view and a warning for an unknown id', () => {
    for (const value of ['status', 'nope', 'settings,nope']) {
      const result = fixtureViewsFromEnv({ KARST_VISUAL_FIXTURE_VIEWS: value });
      expect(result.views).toEqual(ALL_VIEWS);
      expect(result.warning).toContain('fail safe: write every view');
      expect(result.warning).toContain(value.includes('status') ? 'status' : 'nope');
    }
  });
});
