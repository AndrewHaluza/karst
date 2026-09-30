/**
 * The React-view guards from NDL-126 §1, §5 (R01) and §9.4 (R-X5/R-X6/R-X7),
 * expressed as STATIC checks over the settings app source.
 *
 * These are the checks the design says cannot be review-only: the framework
 * dependency is scoped to one directory, the message boundary stays serializable
 * by not hand-rolling async state, and no component reaches around React with
 * inline styles, raw HTML, imperative ARIA, `document.querySelector`, or raw
 * form controls.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // …/src/ui/settings/app
const SRC = join(HERE, '..', '..', '..'); // …/src
const ROOT = join(SRC, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const stripBlockComments = (text: string): string => text.replace(/\/\*.*?\*\//gs, '');
const rel = (file: string): string => relative(ROOT, file);
const isTest = (file: string): boolean => /\.test\.(ts|tsx)$/.test(file);
const isUnderApp = (file: string): boolean => file.startsWith(HERE + sep);

const APP_SOURCE = walk(HERE).filter((file) => !isTest(file));
const APP_OUTSIDE_PRIMITIVES = APP_SOURCE.filter((file) => !file.includes(`${sep}primitives${sep}`));

describe('R01 — React is a dev dependency scoped to the settings app', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('keeps react/react-dom out of runtime dependencies', () => {
    expect(pkg.dependencies?.react).toBeUndefined();
    expect(pkg.dependencies?.['react-dom']).toBeUndefined();
    expect(pkg.devDependencies?.react).toBeDefined();
    expect(pkg.devDependencies?.['react-dom']).toBeDefined();
  });

  it('allows react/react-dom/testing-library imports only under src/ui/settings/app', () => {
    const reactImport =
      /(?:^|\n)\s*(?:import|export)[^\n]*from\s+['"](?:react|react-dom)(?:\/[^'"]*)?['"]/;
    const testingImport =
      /(?:^|\n)\s*import[^\n]*from\s+['"]@testing-library\/react['"]/;
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (reactImport.test(text) || testingImport.test(text)) {
        expect(isUnderApp(file), `${rel(file)} imports React outside the settings app`).toBe(true);
      }
    }
  });
});

describe('R-X6 — no inline style, no raw HTML', () => {
  const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
    ['inline style prop', /style=\{\{/],
    ['imperative element style', /\.style\./],
    ['setAttribute("style")', /setAttribute\(\s*['"]style['"]/],
    ['innerHTML', /\binnerHTML\b/],
    ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ];

  it('never reaches around React to set presentation', () => {
    for (const file of APP_SOURCE) {
      const text = stripBlockComments(readFileSync(file, 'utf8'));
      for (const [name, pattern] of BANNED) {
        expect(pattern.test(text), `${name} in ${rel(file)}`).toBe(false);
      }
    }
  });
});

describe('R-X5/R26/R09b — imperative DOM and unstable keys', () => {
  const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
    ['array-index key', /key=\{\s*(?:i|index)\b/],
    ['imperative aria', /setAttribute\(\s*['"]aria-/],
    ['document.querySelector', /document\.querySelector/],
  ];

  it('derives state and keys from props instead', () => {
    for (const file of APP_SOURCE) {
      const text = stripBlockComments(readFileSync(file, 'utf8'));
      for (const [name, pattern] of BANNED) {
        expect(pattern.test(text), `${name} in ${rel(file)}`).toBe(false);
      }
    }
  });
});

describe('R07/R08/R25 — controls and primitives have one owner', () => {
  it('bans raw form controls outside primitives/', () => {
    for (const file of APP_OUTSIDE_PRIMITIVES) {
      const text = stripBlockComments(readFileSync(file, 'utf8'));
      expect(/<\s*(?:input|select|textarea)\b/.test(text), `raw control in ${rel(file)}`).toBe(false);
    }
  });

  it('bans DS primitive classes outside primitives/', () => {
    const roots = [
      'k-btn',
      'k-iconbtn',
      'k-field',
      'k-status',
      'k-switch',
      'k-chip',
      'k-input',
      'k-select',
      'k-dot',
      'k-spinner',
      'k-live-region',
    ];
    for (const file of APP_OUTSIDE_PRIMITIVES) {
      const text = stripBlockComments(readFileSync(file, 'utf8'));
      for (const token of text.match(/\bk-[a-z0-9-]+/g) ?? []) {
        const owned = roots.some((root) => token === root || token.startsWith(`${root}--`));
        expect(owned, `${token} emitted by ${rel(file)} outside primitives/`).toBe(false);
      }
    }
  });

  it('keeps async lifecycle state inside useHostMutation', () => {
    for (const file of APP_SOURCE) {
      if (file.endsWith('useHostMutation.ts')) continue;
      const text = stripBlockComments(readFileSync(file, 'utf8'));
      expect(
        /const\s*\[\s*(?:pending|loading)\w*\s*,/.test(text),
        `hand-rolled pending state in ${rel(file)}`,
      ).toBe(false);
    }
  });
});