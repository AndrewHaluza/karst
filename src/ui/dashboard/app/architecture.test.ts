/**
 * React-view guards for the dashboard app (R-X5/R-X6/R-X7).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // …/src/ui/dashboard/app
const SRC = join(HERE, '..', '..', '..');
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

const APP_SOURCE = walk(HERE).filter((file) => !isTest(file));

describe('dashboard static guards — non-vacuity', () => {
  it('walks a non-empty app source set', () => {
    expect(APP_SOURCE.length).toBeGreaterThan(0);
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
