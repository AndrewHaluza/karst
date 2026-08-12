/**
 * The three-surface boundary pin (Slice 3 Task 9).
 *
 * `src/workflow/graphMarkerGuard.ts` is the ONLY graph/stage boundary module,
 * and it has exactly one stage-side referrer: `stageResume`. This test walks
 * the reachable import graph and fails if:
 *
 *  - any graph module (approaches/graph, store/graph, cli/node) reaches the
 *    workflow machine — the graph never writes or infers a stage verdict;
 *  - any `src/workflow/` module other than `stageResume` references the
 *    boundary module — a fourth surface appearing anywhere is a violation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

describe('graph/stage boundary (Slice-3 T9)', () => {
  const graphDirs = [
    join(ROOT, 'src', 'approaches', 'graph'),
    join(ROOT, 'src', 'store', 'graph'),
  ];
  const graphFiles = new Set(graphDirs.flatMap(walk));
  const workflowDir = join(ROOT, 'src', 'workflow');

  it('no graph module reaches the workflow machine', () => {
    const violations: string[] = [];
    for (const file of graphFiles) {
      const queue = [file];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const current = queue.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const spec of importsOf(current)) {
          const target = resolveSpecifier(current, spec);
          if (target.endsWith('machine.ts') && target.includes(join('workflow'))) {
            violations.push(`${relative(ROOT, file)} → ${target}`);
          } else if (target.endsWith('.ts') && statSync(target).isFile()) {
            queue.push(target);
          }
        }
      }
    }
    expect(violations, 'graph module reaching the stage machine').toEqual([]);
  });

  it('no workflow module other than stageResume references the boundary module', () => {
    const violations: string[] = [];
    for (const file of walk(workflowDir)) {
      if (file.endsWith('graphMarkerGuard.ts')) continue;
      for (const spec of importsOf(file)) {
        const target = resolveSpecifier(file, spec);
        if (target.endsWith('graphMarkerGuard.ts')) {
          if (!file.endsWith('stageResume.ts')) {
            violations.push(relative(ROOT, file));
          }
        }
      }
    }
    expect(violations, 'a fourth surface referencing graphMarkerGuard').toEqual([]);
  });
});
