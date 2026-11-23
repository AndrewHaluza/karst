/**
 * Which screenshot project schedules which test (playwright.config.ts).
 *
 * Playwright applies these filters before it sets up a fixture. A test that a
 * project does not run is not scheduled there. Before, each such test started,
 * set up its page fixture and called `testInfo.skip()`: about 3,050 skipped
 * tests, about 40 ms each, in the CI sweep.
 *
 * - A whole spec file that runs in some projects only: `FILE_PROJECTS`, applied
 *   as a per-project `testIgnore`.
 * - A pages.visual.ts variant that runs in some themes only: the test carries
 *   the tag `@NOT-<PROJECT>` for each project outside its themes, and each
 *   project has a `grepInvert` for its own tag. A project-level `grepInvert`
 *   does not replace the global `grep` (KARST_UI_GREP), so local narrowing
 *   still works. Tags do not change the test title, the test id or the
 *   baseline name.
 *
 * Playwright matches a grep against the title AND the tags. The tag is upper
 * case, so a lower-case grep such as `KARST_UI_GREP=catalog` (a view and a
 * project name) does not select every test tagged for the catalog project.
 */

/** Every project of playwright.config.ts except the layout chain, in config order. */
export const SCREENSHOT_PROJECTS: readonly string[] = Object.freeze([
  'dark',
  'light',
  'hc',
  'dark-grayscale',
  'dark-reduced-motion',
  'catalog',
]);

/** Spec files that run in some screenshot projects only: file name, then its projects. */
export const FILE_PROJECTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'catalog.visual.ts': ['catalog'],
  'contentCap.visual.ts': ['dark'],
  'servers.visual.ts': ['dark'],
  'subtasks.visual.ts': ['dark'],
  'status.visual.ts': ['dark', 'dark-grayscale', 'dark-reduced-motion'],
  'stagePalette.visual.ts': ['dark', 'light', 'hc'],
  // T1318: the sidebar's geometry checks read the dark page; the state shapes record their own themes.
  'sidebar.visual.ts': ['dark'],
});

const TAG_PREFIX = '@NOT-';

const tagOf = (project: string): string => `${TAG_PREFIX}${project.toUpperCase()}`;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The `testIgnore` globs of one project: each file of FILE_PROJECTS that does not list it. */
export function testIgnoreFor(project: string): string[] {
  return Object.entries(FILE_PROJECTS)
    .filter(([, projects]) => !projects.includes(project))
    .map(([file]) => `**/${file}`);
}

/** The tags of a test that runs in `themes`: one `@NOT-<PROJECT>` for each other screenshot project. */
export function outsideTags(themes: readonly string[]): string[] {
  return SCREENSHOT_PROJECTS.filter((p) => !themes.includes(p)).map(tagOf);
}

/** The `grepInvert` of one project: its own tag as a whole word, so `dark` never matches `@NOT-DARK-GRAYSCALE`. */
export function outsideGrep(project: string): RegExp {
  return new RegExp(`(?:^|\\s)${escapeRegExp(tagOf(project))}(?=\\s|$)`);
}
