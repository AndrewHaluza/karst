/**
 * The injected-debug seam pin (Slice 6 Task 3).
 *
 * Graph modules receive `debug` as an INJECTED callback — never by importing
 * the logger (`src/logging/logger.ts`). This test walks the reachable import
 * graph of every `src/approaches/graph` module and fails on any path that
 * lands on the logger: a graph module that imports it would couple the
 * coordinator to the logging side channel the injection seam exists to avoid,
 * and the diagnostics module (`diagnostics.ts`) must stay a pure emitter that
 * only ever passes lines to a callback.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GRAPH_DIR = join(ROOT, 'src', 'approaches', 'graph');
const LOGGER = join(ROOT, 'src', 'logging', 'logger.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** All module-relative specifiers imported (directly) by a file. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const match of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    if (match[1]!.startsWith('.')) out.push(match[1]!);
  }
  return out;
}

function resolveSpecifier(file: string, spec: string): string {
  const base = join(dirname(file), spec);
  const candidates = [base, `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((c) => {
    try {
      return statSync(c).isFile();
    } catch {
      return false;
    }
  }) ?? base;
}

describe('graph modules never import the logger (injected-debug seam)', () => {
  it('no reachable graph import lands on src/logging/logger', () => {
    const violations: string[] = [];
    for (const file of walk(GRAPH_DIR)) {
      const queue = [file];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const current = queue.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const spec of importsOf(current)) {
          const target = resolveSpecifier(current, spec);
          if (target === LOGGER) {
            violations.push(`${relative(ROOT, file)} → ${relative(ROOT, target)}`);
          } else if (target.endsWith('.ts') && statSync(target).isFile()) {
            queue.push(target);
          }
        }
      }
    }
    expect(violations, 'a graph module importing the logger').toEqual([]);
  });
});
