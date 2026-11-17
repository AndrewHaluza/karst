import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '../../manifest/types.js';
import { createGraphDepsPreflight } from './graphDepsPreflight.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const gated = { uat: { gates: [{ id: 'g', command: 'true' }] } } as unknown as Manifest;

describe('createGraphDepsPreflight', () => {
  it('keeps the warning for the header while a repository is a gap and drops it when it is not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gdp-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'Makefile'), 'all:');
    const seen: number[] = [];
    const p = createGraphDepsPreflight({
      manifest: () => gated,
      domainsOf: (id) => (seen.push(id), [{ repoName: 'web', worktreePath: dir }]),
      gitCommonDirOf: () => null,
    });
    expect(p.warningOf(3)).toBeUndefined();
    expect(await p.preflight(3)).toBe('deps: web not provided');
    expect(p.warningOf(3)).toBe('deps: web not provided');
    expect(p.warningOf(4)).toBeUndefined();
    writeFileSync(join(dir, 'go.mod'), 'module x');
    expect(await p.preflight(3)).toBeUndefined();
    expect(p.warningOf(3)).toBeUndefined();
    expect(seen).toEqual([3, 3]);
  });
});
