import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The `lint:layers` script runs `depcruise src --config .dependency-cruiser.cjs`.
// The rules match `^src/...` paths, so the fixture tree has its own `src/` root.
const repoRoot = resolve(import.meta.dirname, '..');
const config = join(repoRoot, '.dependency-cruiser.cjs');

// A ticket worktree can share the `node_modules` of a parent checkout, so walk up.
function findDepcruise(from: string): string {
  for (let d = from; ; d = dirname(d)) {
    const bin = join(d, 'node_modules', '.bin', 'depcruise');
    if (existsSync(bin)) return bin;
    if (dirname(d) === d) throw new Error('depcruise binary not found');
  }
}
const depcruise = findDepcruise(repoRoot);

let dir: string | undefined;

function runLayers(files: Record<string, string>): { status: number | null; out: string } {
  dir = mkdtempSync(join(tmpdir(), 'karst-layers-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler' } }));
  const res = spawnSync(depcruise, ['src', '--config', config], { cwd: dir, encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('layer rules check (lint:layers)', () => {
  it('passes on a tree that follows the rules', () => {
    const r = runLayers({
      'src/workflow/a.ts': 'export const a = 1;\n',
      'src/store/b.ts': "import type { a } from '../workflow/a';\nexport type B = typeof a;\n",
    });
    expect(r.out).toContain('no dependency violations found');
    expect(r.status).toBe(0);
  });

  it('fails on a store value import of workflow', () => {
    const r = runLayers({
      'src/workflow/a.ts': 'export const a = 1;\n',
      'src/store/b.ts': "import { a } from '../workflow/a';\nexport const b = a;\n",
    });
    expect(r.out).toContain('store-no-workflow-value');
    expect(r.status).not.toBe(0);
  });
});
