import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackageScripts, REVIEW_GATES } from './scripts.js';

describe('readPackageScripts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'karst-scripts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the scripts a repo actually defines', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }),
    );
    expect(readPackageScripts(dir)).toEqual({ test: 'vitest run', typecheck: 'tsc --noEmit' });
  });

  it('reports no scripts rather than throwing when there is no package.json', () => {
    // A non-node repo must not crash the gate — it simply answers nothing.
    expect(readPackageScripts(dir)).toEqual({});
  });

  it('reports no scripts when package.json is unreadable or malformed', () => {
    writeFileSync(join(dir, 'package.json'), '{ not json');
    expect(readPackageScripts(dir)).toEqual({});
  });

  it('reports no scripts when package.json has no scripts block', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(readPackageScripts(dir)).toEqual({});
  });
});

describe('REVIEW_GATES', () => {
  it('names the package.json script each gate depends on', () => {
    // The script name is what makes a gate answerable: `npm run lint` in a repo
    // with no lint script exits 1, which is a fact about the repo's config, not
    // about the ticket's code.
    expect(REVIEW_GATES.map((g) => [g.name, g.script])).toEqual([
      ['lint', 'lint'],
      ['typecheck', 'typecheck'],
      ['test', 'test'],
    ]);
  });
});
