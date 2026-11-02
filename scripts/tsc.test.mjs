import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('scripts/tsc.mjs', () => {
  it('resolves typescript without a local node_modules (worktree shape)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsc-wt-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'tsconfig.json'), '{"files":[]}');
    const r = spawnSync(process.execPath, [resolve('scripts/tsc.mjs'), '--version'], { cwd: dir, encoding: 'utf8' });
    expect(r.stderr).not.toContain('MODULE_NOT_FOUND');
    expect(r.stdout).toMatch(/Version \d+/);
  });
});
