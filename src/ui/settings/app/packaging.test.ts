/**
 * Packaging guard for the React migration (NDL-126 §1).
 *
 * The design calls for a `vsce ls` assertion that no `react*` path ships. `vsce`
 * is not a repo dependency and `npx` is not hermetic (and in this workspace npm
 * redacts the dependency UUIDs `vsce ls` needs), so this test pins the same
 * property statically instead: `.vscodeignore` must keep its one-glob-per-line
 * shape, and replaying those rules over a candidate file list must exclude every
 * React/dev path while still including the two runtime dependencies.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');

const LINES = readFileSync(join(ROOT, '.vscodeignore'), 'utf8').split('\n');
const RULES = LINES.map((line) => line.trim()).filter(
  (line) => line.length > 0 && !line.startsWith('#'),
);

function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`${source}$`);
}

function isIgnored(path: string): boolean {
  let ignored = false;
  for (const rule of RULES) {
    const negated = rule.startsWith('!');
    const pattern = negated ? rule.slice(1) : rule;
    if (globToRegExp(pattern).test(path)) ignored = !negated;
  }
  return ignored;
}

describe('.vscodeignore packaging', () => {
  it('keeps exactly one glob per line (vsce splits on newlines only)', () => {
    for (const line of RULES) {
      expect(line.split(/\s+/), `"${line}" is not a single glob`).toHaveLength(1);
    }
  });

  it('excludes React, testing-library and eslint from the VSIX', () => {
    for (const path of [
      'node_modules/react/index.js',
      'node_modules/react-dom/index.js',
      'node_modules/@testing-library/react/index.js',
      'node_modules/@testing-library/dom/index.js',
      'node_modules/eslint/bin/eslint.js',
      'node_modules/@types/react/index.d.ts',
    ]) {
      expect(isIgnored(path), `${path} would ship`).toBe(true);
    }
  });

  it('still includes the two runtime dependencies', () => {
    expect(isIgnored('node_modules/better-sqlite3/build/Release/better_sqlite3.node')).toBe(false);
    expect(isIgnored('node_modules/js-yaml/index.js')).toBe(false);
  });

  it('never re-includes a React path with a negation rule', () => {
    for (const rule of RULES.filter((line) => line.startsWith('!'))) {
      expect(/react|testing-library|eslint/i.test(rule), `${rule} re-includes a dev dependency`).toBe(
        false,
      );
    }
  });
});