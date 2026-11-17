import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countArtifactFiles } from './artifactFiles.js';

describe('countArtifactFiles', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'karst-art-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is 0 for a missing dir', () => {
    expect(countArtifactFiles(join(root, 'nope'))).toBe(0);
  });
  it('is 0 for an empty dir and for a dir of empty sub-dirs', () => {
    mkdirSync(join(root, 'a'));
    expect(countArtifactFiles(root)).toBe(0);
  });
  it('counts files, including those in sub-dirs', () => {
    writeFileSync(join(root, 'plan.md'), 'x');
    mkdirSync(join(root, 'shots'));
    writeFileSync(join(root, 'shots', '1.png'), 'x');
    expect(countArtifactFiles(root)).toBe(2);
  });
  it('does not enter sub-dirs below the depth bound', () => {
    let d = root;
    for (let i = 0; i < 6; i++) { d = join(d, `d${i}`); mkdirSync(d); }
    writeFileSync(join(d, 'deep.md'), 'x');
    expect(countArtifactFiles(root)).toBe(0);
  });
});
