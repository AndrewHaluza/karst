import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TMP_DIR_ENV, fixtureDir } from './fixtureDir.mjs';

describe('fixtureDir', () => {
  const fallback = '/repo/tests/visual/.tmp';

  it('reads KARST_VISUAL_TMP_DIR', () => {
    expect(TMP_DIR_ENV).toBe('KARST_VISUAL_TMP_DIR');
  });

  it('gives the fallback when the variable is unset or empty', () => {
    expect(fixtureDir({}, fallback)).toBe(fallback);
    expect(fixtureDir({ KARST_VISUAL_TMP_DIR: '' }, fallback)).toBe(fallback);
  });

  it('gives an absolute path unchanged', () => {
    expect(fixtureDir({ KARST_VISUAL_TMP_DIR: '/tmp/karst-visual-fixtures' }, fallback)).toBe('/tmp/karst-visual-fixtures');
  });

  it('accepts a dedicated leaf directory in the system temp directory', () => {
    const leaf = join(tmpdir(), 'karst-visual-pages');
    expect(fixtureDir({ KARST_VISUAL_TMP_DIR: leaf }, fallback)).toBe(leaf);
  });

  it('normalizes the accepted value with path.resolve', () => {
    expect(fixtureDir({ KARST_VISUAL_TMP_DIR: '/tmp/karst-visual-fixtures/' }, fallback)).toBe('/tmp/karst-visual-fixtures');
    expect(fixtureDir({ KARST_VISUAL_TMP_DIR: '/tmp/./karst-visual-a' }, fallback)).toBe('/tmp/karst-visual-a');
  });

  it('throws, naming the variable, for every value that is not a dedicated leaf directory', () => {
    const rejected = [
      '//', '/.', '/./', '/', '/tmp', '/work', homedir(), process.cwd(),
      'tmp/pages', './pages', '..', '/tmp/../etc', '/tmp/a/..',
      '/tmp/other', '/tmp/karst-visual-a/b', '/var/karst-visual-a', '/tmp/xkarst-visual-a',
    ];
    for (const value of rejected) {
      expect(() => fixtureDir({ KARST_VISUAL_TMP_DIR: value }, fallback), value).toThrow(/KARST_VISUAL_TMP_DIR/);
    }
  });
});
