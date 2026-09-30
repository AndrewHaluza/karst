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

/**
 * A banned-pattern loop proves nothing if the file walk returned nothing, and a
 * regex that never matches proves nothing either. Both failure modes pass
 * silently, so every guard below asserts non-vacuity first and each regex is
 * shown to fire on a known-bad fixture (NDL-126 §9.5: COMPONENT/STATIC checks
 * are only evidence if they can actually fail).
 */
describe('non-vacuity of the static guards', () => {
  it('walks a non-empty app source set', () => {
    expect(APP_SOURCE.length).toBeGreaterThan(0);
    expect(APP_OUTSIDE_PRIMITIVES.length).toBeGreaterThan(0);
    // primitives/ must be a strict subset, or the "outside primitives" guards
    // would silently be scanning the same files as the whole-app guards.
    expect(APP_OUTSIDE_PRIMITIVES.length).toBeLessThan(APP_SOURCE.length);
  });

  it('walks a non-empty src set for the R01 import guard', () => {
    expect(walk(SRC).length).toBeGreaterThan(0);
  });
});

/**
 * Each entry is the pattern under test plus a fixture that MUST match it. If a
 * pattern is later loosened (or a regex typo slips in) this fails instead of
 * silently passing every file in the app.
 */
function expectPatternsFire(
  patterns: ReadonlyArray<readonly [string, RegExp]>,
  fixtures: Readonly<Record<string, string>>,
): void {
  for (const [name, pattern] of patterns) {
    const fixture = fixtures[name];
    if (fixture === undefined) {
      throw new Error(`no known-bad fixture registered for banned pattern "${name}"`);
    }
    expect(
      pattern.test(stripBlockComments(fixture)),
      `"${name}" does not fire on its fixture — the regex cannot catch a violation`,
    ).toBe(true);
  }
}

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
    // Four spellings reach React, and the guard has to catch all of them:
    // `import ... from 'react'`, side-effect `import 'react'` (no `from`),
    // `export ... from 'react'`, and CommonJS `require('react')`. Matching only
    // the first would let the other three put React outside the settings app.
    const FROM_IMPORT =
      /(?:^|\n)\s*(?:import|export)[^\n]*\bfrom\s+['"](?:react|react-dom|@testing-library\/react)(?:\/[^'"]*)?['"]/;
    const SIDE_EFFECT_IMPORT =
      /(?:^|\n)\s*import\s+['"](?:react|react-dom|@testing-library\/react)(?:\/[^'"]*)?['"]/;
    const REQUIRE =
      /\brequire\(\s*['"](?:react|react-dom|@testing-library\/react)(?:\/[^'"]*)?['"]\s*\)/;
    const DYNAMIC_IMPORT =
      /\bimport\(\s*['"](?:react|react-dom|@testing-library\/react)(?:\/[^'"]*)?['"]\s*\)/;
    const REACT_IMPORT = [FROM_IMPORT, SIDE_EFFECT_IMPORT, REQUIRE, DYNAMIC_IMPORT];

    // Non-vacuity: every spelling must fire on its own fixture, or a spelling
    // silently stops being guarded and the loop below proves nothing about it.
    const fixtures: ReadonlyArray<readonly [RegExp, string]> = [
      [FROM_IMPORT, `import { useState } from 'react';`],
      [SIDE_EFFECT_IMPORT, `import 'react/jsx-runtime';`],
      [REQUIRE, `const r = require('react');`],
      [DYNAMIC_IMPORT, `const m = await import('react-dom/client');`],
    ];
    for (const [pattern, fixture] of fixtures) {
      expect(pattern.test(fixture), `R01 guard misses ${JSON.stringify(fixture)}`).toBe(true);
    }
    // And a non-React import must not trip any of them.
    for (const [pattern] of fixtures) {
      expect(pattern.test(`import { readFileSync } from 'node:fs';`)).toBe(false);
    }

    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      if (REACT_IMPORT.some((pattern) => pattern.test(text))) {
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
    expectPatternsFire(BANNED, {
      'inline style prop': 'const a = <div style={{ color: "red" }} />;',
      'imperative element style': 'node.style.display = "none";',
      'setAttribute("style")': `node.setAttribute('style', 'color:red');`,
      innerHTML: 'node.innerHTML = markup;',
      dangerouslySetInnerHTML:
        'const el = <div dangerouslySetInnerHTML={{ __html: markup }} />;',
    });
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
    expectPatternsFire(BANNED, {
      'array-index key': 'const el = <li key={i}>{x}</li>;',
      'imperative aria': `node.setAttribute('aria-expanded', 'true');`,
      'document.querySelector': 'const el = document.querySelector(".k-tab");',
    });
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
    const RAW_CONTROL = /<\s*(?:input|select|textarea)\b/;
    expect(RAW_CONTROL.test('const el = <input value={v} />;')).toBe(true);
    expect(RAW_CONTROL.test('const el = <Field control={{ kind: "input" }} />;')).toBe(false);
    for (const file of APP_OUTSIDE_PRIMITIVES) {
      const text = stripBlockComments(readFileSync(file, 'utf8'));
      expect(RAW_CONTROL.test(text), `raw control in ${rel(file)}`).toBe(false);
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
    const isPrimitiveClass = (token: string): boolean =>
      roots.some((root) => token === root || token.startsWith(`${root}--`));

    // Non-vacuity: a token matcher that never matched anything would pass the
    // loop below regardless of what the app renders.
    const tokens = 'className="k-btn k-status--ok k-chip--warn"'.match(/\bk-[a-z0-9-]+/g) ?? [];
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every(isPrimitiveClass)).toBe(true);
    // A modifier on a non-primitive root must not be treated as owned.
    expect(isPrimitiveClass('k-btnx')).toBe(false);

    for (const file of APP_OUTSIDE_PRIMITIVES) {
      const text = stripBlockComments(readFileSync(file, 'utf8'));
      for (const token of text.match(/\bk-[a-z0-9-]+/g) ?? []) {
        expect(isPrimitiveClass(token), `${token} emitted by ${rel(file)} outside primitives/`).toBe(
          false,
        );
      }
    }
  });

  it('keeps async lifecycle state inside useHostMutation', () => {
    const HAND_ROLLED = /const\s*\[\s*(?:pending|loading)\w*\s*,/;
    expect(HAND_ROLLED.test('const [pendingSave, setPendingSave] = useState(false);')).toBe(true);
    expect(HAND_ROLLED.test('const [sections, setSections] = useState([]);')).toBe(false);
    for (const file of APP_SOURCE) {
      if (file.endsWith('useHostMutation.ts')) continue;
      const text = stripBlockComments(readFileSync(file, 'utf8'));
      expect(HAND_ROLLED.test(text), `hand-rolled pending state in ${rel(file)}`).toBe(false);
    }
  });
});
