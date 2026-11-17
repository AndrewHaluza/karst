import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasArtifactFiles } from './artifactFiles.js';

describe('hasArtifactFiles', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-art-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is false for a missing dir', async () => {
    expect(await hasArtifactFiles(join(root, 'nope'))).toBe(false);
  });
  it('is false for an empty dir and for a dir of empty sub-dirs', async () => {
    mkdirSync(join(root, 'a'));
    expect(await hasArtifactFiles(root)).toBe(false);
  });
  it('finds a file at the top or in a sub-dir', async () => {
    writeFileSync(join(root, 'plan.md'), 'x');
    mkdirSync(join(root, 'shots'));
    writeFileSync(join(root, 'shots', '1.png'), 'x');
    expect(await hasArtifactFiles(root)).toBe(true);
  });
  it('does not enter sub-dirs below the depth bound', async () => {
    let d = root;
    for (let i = 0; i < 6; i++) { d = join(d, `d${i}`); mkdirSync(d); }
    writeFileSync(join(d, 'deep.md'), 'x');
    expect(await hasArtifactFiles(root)).toBe(false);
  });
});
