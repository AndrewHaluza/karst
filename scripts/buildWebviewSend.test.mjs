import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomic } from './build-webview-send.mjs';

describe('writeFileAtomic (T1251)', () => {
  it('replaces the file whole and leaves no temp file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-atomic-'));
    try {
      const target = join(dir, 'app.webview.js');
      writeFileSync(target, 'old bundle');
      writeFileAtomic(target, 'new bundle');
      expect(readFileSync(target, 'utf8')).toBe('new bundle');
      expect(readdirSync(dir)).toEqual(['app.webview.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves no temp file when the rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karst-atomic-'));
    try {
      // A directory at the target path makes the rename fail after the temp file is written.
      const target = join(dir, 'taken');
      mkdirSync(target);
      expect(() => writeFileAtomic(target, 'bundle')).toThrow();
      expect(readdirSync(dir)).toEqual(['taken']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
