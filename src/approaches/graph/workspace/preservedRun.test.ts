/** The per-run listing of the preserved patches (T1323). */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPreservedWorkForRun } from './preserve.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function artifactRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'karst-preserved-run-'));
  roots.push(root);
  return root;
}

function patch(root: string, dir: string, repo: string, paths: string[]): void {
  mkdirSync(join(root, 'preserved', dir), { recursive: true });
  writeFileSync(join(root, 'preserved', dir, `${repo}.patch`), 'diff');
  writeFileSync(join(root, 'preserved', dir, `${repo}.paths.json`), JSON.stringify(paths));
}

describe('readPreservedWorkForRun', () => {
  it('lists each patch in node-run order with a path relative to the artifact root', () => {
    const root = artifactRoot();
    patch(root, '10', 'api', ['x.ts']);
    patch(root, '9', 'web', ['y.ts']);
    patch(root, '9', 'api', ['z.ts']);
    expect(readPreservedWorkForRun({ artifactRoot: () => root }, 1)).toEqual([
      { nodeRunId: 9, patchPath: 'preserved/9/api.patch', paths: ['z.ts'] },
      { nodeRunId: 9, patchPath: 'preserved/9/web.patch', paths: ['y.ts'] },
      { nodeRunId: 10, patchPath: 'preserved/10/api.patch', paths: ['x.ts'] },
    ]);
  });

  it('ignores a directory whose name is not a node run id', () => {
    const root = artifactRoot();
    patch(root, 'notes', 'api', []);
    patch(root, '0x1', 'api', []);
    expect(readPreservedWorkForRun({ artifactRoot: () => root }, 1)).toEqual([]);
  });

  it('is empty without an artifact root and without a preserved directory', () => {
    expect(readPreservedWorkForRun({ artifactRoot: () => '' }, 1)).toEqual([]);
    expect(readPreservedWorkForRun({ artifactRoot: () => artifactRoot() }, 1)).toEqual([]);
  });
});
