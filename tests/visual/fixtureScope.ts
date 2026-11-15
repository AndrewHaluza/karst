/**
 * The views whose fixture pages the fixture writer writes (@ui:FIXTURE-SCOPE).
 *
 * A local gate sets KARST_VISUAL_FIXTURE_VIEWS from the same selection that builds
 * KARST_UI_GREP (fixtureViews in scripts/uiViews.mjs). Unset or empty means every
 * view, which is the CI and full-run behaviour. An unknown id also gives every view:
 * a page too many costs time, a page too few breaks a screenshot.
 */
import { ALL_VIEWS, type ViewId } from './corpora.js';

export const FIXTURE_VIEWS_ENV = 'KARST_VISUAL_FIXTURE_VIEWS';

export interface FixtureViews {
  readonly views: readonly ViewId[];
  /** A line for stderr when the value holds an unknown id, else null. */
  readonly warning: string | null;
}

const isViewId = (id: string): id is ViewId => (ALL_VIEWS as readonly string[]).includes(id);

const HTTP_NOT_FOUND = 404;

/**
 * The error text for a fixture page that the server does not have, or null when the server has it.
 * `status` is the HTTP status of the page load (null when Playwright gives no response).
 */
export function missingFixtureMessage({
  path,
  status,
  env,
}: {
  path: string;
  status: number | null;
  env: Record<string, string | undefined>;
}): string | null {
  if (status !== HTTP_NOT_FOUND) return null;
  const scoped = (env[FIXTURE_VIEWS_ENV] ?? '').trim();
  if (scoped === '') return `fixture page ${path} not found: the fixture writer wrote no such page (tests/visual/buildFixture.ts)`;
  return (
    `fixture page ${path} not found: this run writes only the pages of ${FIXTURE_VIEWS_ENV}=${scoped}. ` +
    `Repair: add the view to fixtureViews in scripts/uiViews.mjs, or unset ${FIXTURE_VIEWS_ENV}`
  );
}

export function fixtureViewsFromEnv(env: Record<string, string | undefined>): FixtureViews {
  const ids = (env[FIXTURE_VIEWS_ENV] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return { views: ALL_VIEWS, warning: null };
  const unknown = ids.filter((id) => !isViewId(id));
  if (unknown.length > 0) {
    return {
      views: ALL_VIEWS,
      warning: `${FIXTURE_VIEWS_ENV}: unknown view id ${unknown.join(', ')}; fail safe: write every view`,
    };
  }
  return { views: ids.filter(isViewId), warning: null };
}
