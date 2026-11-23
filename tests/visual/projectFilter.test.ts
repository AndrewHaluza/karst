import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FILE_PROJECTS, outsideGrep, outsideTags, SCREENSHOT_PROJECTS, testIgnoreFor } from './projectFilter.js';
import { VARIANTS } from './variants.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));

/** The project names of playwright.config.ts, in config order (the screenshot projects use a helper). */
function configProjects(): string[] {
  const text = readFileSync(join(ROOT, 'playwright.config.ts'), 'utf8');
  const body = text.slice(text.indexOf('projects: ['));
  return [
    ...[...body.matchAll(/screenshotProject\('([^']+)'/g)].map((m) => m[1]!),
    ...[...body.matchAll(/^\s+name: '([^']+)',$/gm)].map((m) => m[1]!),
  ];
}

/** The grep title Playwright matches a test against: title path, then tags. */
const grepTitle = (title: string, tags: readonly string[]): string => ['full-page screenshots', title, ...tags].join(' ');

describe('SCREENSHOT_PROJECTS', () => {
  it('names every project of playwright.config.ts except the layout chain', () => {
    const screenshot = configProjects().filter((p) => !p.startsWith('layout'));
    expect([...SCREENSHOT_PROJECTS].sort()).toEqual(screenshot.sort());
  });

  it('holds every theme a variant declares, so no variant runs in no project', () => {
    const unknown = Object.values(VARIANTS)
      .flat()
      .flatMap((v) => v.themes.filter((t) => !SCREENSHOT_PROJECTS.includes(t)).map((t) => `${v.id}: ${t}`));
    expect(unknown).toEqual([]);
  });
});

describe('outsideTags and outsideGrep', () => {
  it('tags a variant with each screenshot project outside its themes', () => {
    expect(outsideTags(['dark', 'light', 'hc'])).toEqual(['@NOT-DARK-GRAYSCALE', '@NOT-DARK-REDUCED-MOTION', '@NOT-CATALOG']);
    expect(outsideTags(SCREENSHOT_PROJECTS)).toEqual([]);
  });

  it('removes a test from exactly the projects outside its themes', () => {
    for (const themes of [['dark'], ['dark', 'light'], ['dark-reduced-motion'], ['dark', 'light', 'hc']]) {
      const title = grepTitle('dashboard/x: full-page screenshot', outsideTags(themes));
      const kept = SCREENSHOT_PROJECTS.filter((p) => !outsideGrep(p).test(title));
      expect(kept).toEqual(themes);
    }
  });

  it('never matches a project name inside a longer one or a title without the tag', () => {
    expect(outsideGrep('dark').test(grepTitle('t', ['@NOT-DARK-GRAYSCALE']))).toBe(false);
    expect(outsideGrep('dark').test(grepTitle('dark: @NOT-DARKER', []))).toBe(false);
    expect(outsideGrep('dark').test(grepTitle('t', ['@NOT-DARK']))).toBe(true);
  });

  it('keeps a lower-case grep of a project or view name off the tags', () => {
    const tags = outsideTags(['dark']);
    for (const name of [...SCREENSHOT_PROJECTS, 'not']) {
      expect(tags.some((t) => new RegExp(name).test(t)), name).toBe(false);
    }
  });
});

describe('testIgnoreFor', () => {
  it('ignores a file in each project outside its list', () => {
    expect(testIgnoreFor('catalog')).toEqual([
      '**/contentCap.visual.ts',
      '**/servers.visual.ts',
      '**/subtasks.visual.ts',
      '**/status.visual.ts',
      '**/stagePalette.visual.ts',
      '**/sidebar.visual.ts',
    ]);
    expect(testIgnoreFor('dark')).toEqual(['**/catalog.visual.ts']);
    expect(testIgnoreFor('dark-grayscale')).toEqual([
      '**/catalog.visual.ts',
      '**/contentCap.visual.ts',
      '**/servers.visual.ts',
      '**/subtasks.visual.ts',
      '**/stagePalette.visual.ts',
      '**/sidebar.visual.ts',
    ]);
  });

  it('lists only spec files that exist and only screenshot projects', () => {
    for (const [file, projects] of Object.entries(FILE_PROJECTS)) {
      expect(() => readFileSync(join(HERE, file)), file).not.toThrow();
      expect(projects.every((p) => SCREENSHOT_PROJECTS.includes(p)), file).toBe(true);
    }
  });
});
