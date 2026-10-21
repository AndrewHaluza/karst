import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { tintSvg, glyphIconPath } from './glyphIcon.js';
import { glyphHex } from '../model/glyphColor.js';

const SRC = '<svg stroke="currentColor"><circle/></svg>';

describe('tintSvg', () => {
  it('replaces every currentColor with the hex', () => {
    expect(tintSvg(SRC, '#e35555')).toBe('<svg stroke="#e35555"><circle/></svg>');
  });
  it('is a no-op when there is no currentColor', () => {
    expect(tintSvg('<svg stroke="#000"/>', '#e35555')).toBe('<svg stroke="#000"/>');
  });
  it('leaves the source string unmutated (returns a new string)', () => {
    const src = SRC;
    tintSvg(src, '#38a86b');
    expect(src).toBe(SRC);
  });
});

describe('glyphIconPath', () => {
  let storageDir = '';
  let assetSvgPath = '';

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), 'karst-glyph-test-'));
    assetSvgPath = join(storageDir, 'mark.svg');
    writeFileSync(assetSvgPath, '<svg><path fill="currentColor"/></svg>', 'utf8');
  });

  it('materializes a content-addressed file under <storageDir>/icons', () => {
    const p = glyphIconPath('green', { storageDir, assetSvgPath });
    expect(dirname(p)).toBe(join(storageDir, 'icons'));
    const hex = glyphHex('green');
    const expectedContent = `<svg><path fill="${hex}"/></svg>`;
    const hash = createHash('sha256').update(expectedContent, 'utf8').digest('hex').slice(0, 8);
    expect(basename(p)).toBe(`karst-green-${hash}.svg`);
    expect(readFileSync(p, 'utf8')).toBe(expectedContent);
  });

  it('same source called twice -> same path, same bytes, no rewrite', () => {
    const first = glyphIconPath('blue', { storageDir, assetSvgPath });
    writeFileSync(first, '<svg data-sentinel="1"/>', 'utf8');
    const second = glyphIconPath('blue', { storageDir, assetSvgPath });
    expect(second).toBe(first);
    expect(readFileSync(second, 'utf8')).toBe('<svg data-sentinel="1"/>');
  });

  it('changed source yields a new path with matching hash', () => {
    const first = glyphIconPath('red', { storageDir, assetSvgPath });
    writeFileSync(assetSvgPath, '<svg><circle fill="currentColor"/></svg>', 'utf8');
    const second = glyphIconPath('red', { storageDir, assetSvgPath });
    expect(second).not.toBe(first);
    expect(readFileSync(first, 'utf8')).toContain('<path');
    expect(readFileSync(second, 'utf8')).toContain('<circle');
  });

  it('different glyphs yield distinct paths and files', () => {
    const blue = glyphIconPath('blue', { storageDir, assetSvgPath });
    const red = glyphIconPath('red', { storageDir, assetSvgPath });
    expect(blue).not.toBe(red);
    expect(readFileSync(blue, 'utf8')).toContain(glyphHex('blue'));
    expect(readFileSync(red, 'utf8')).toContain(glyphHex('red'));
  });
});
