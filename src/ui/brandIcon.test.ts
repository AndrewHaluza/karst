import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { brandIconPaths } from './brandIcon.js';
import { glyphIconPath } from './glyphIcon.js';

const ASSET = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'media', 'karst.svg');

let storageDir = '';
beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'karst-brand-'));
});

const paths = (): { light: string; dark: string } =>
  brandIconPaths({ storageDir, assetSvgPath: ASSET });

describe('brandIconPaths', () => {
  it('materializes one status-free brand file under <storageDir>/icons', () => {
    const p = paths();
    expect(dirname(p.light)).toBe(join(storageDir, 'icons'));
    expect(p.light).toBe(p.dark);
    expect(readFileSync(p.light, 'utf8')).toContain('<svg');
  });

  // The activity-bar mark is monochrome: VS Code tints currentColor for the
  // active/inactive state, so one file serves both themes with no hue baked in.
  it('returns the approved mark for both themes, in currentColor', () => {
    const p = paths();
    const content = readFileSync(p.light, 'utf8');
    expect(content).toContain('M 96 20');
    expect(content).toContain('cx="106.5" cy="111.5" r="26.5"');
    expect(content).toContain('currentColor');
  });

  it('the two themes point at the SAME file (the mark needs no per-theme hue)', () => {
    const p = paths();
    expect(p.light).toBe(p.dark);
  });

  // The brand mark carries no status: it must never resolve to a file the
  // status ramp writes, or a Settings tab would read as an idle ticket.
  it('never collides with a status-tinted glyph icon', () => {
    const p = paths();
    const gray = glyphIconPath('gray', { storageDir, assetSvgPath: ASSET });
    expect([p.light, p.dark]).not.toContain(gray);
    expect(basename(p.light)).toMatch(/^karst-brand-[0-9a-f]{8}\.svg$/);
    expect(basename(gray)).toMatch(/^karst-gray-[0-9a-f]{8}\.svg$/);
  });

  it('same source called twice -> same path, same bytes, no rewrite', () => {
    const first = paths();
    writeFileSync(first.dark, '<svg data-kept="1"/>', 'utf8');
    const second = paths();
    expect(second).toEqual(first);
    expect(readFileSync(second.dark, 'utf8')).toBe('<svg data-kept="1"/>');
  });

  it('source changed between calls -> different path, bytes equal the new source', () => {
    const tmpSource = join(storageDir, 'dynamic.svg');
    writeFileSync(tmpSource, '<svg id="v1"/>', 'utf8');
    const first = brandIconPaths({ storageDir, assetSvgPath: tmpSource });
    expect(readFileSync(first.light, 'utf8')).toBe('<svg id="v1"/>');

    writeFileSync(tmpSource, '<svg id="v2"/>', 'utf8');
    const second = brandIconPaths({ storageDir, assetSvgPath: tmpSource });
    expect(second.light).not.toBe(first.light);
    expect(readFileSync(second.light, 'utf8')).toBe('<svg id="v2"/>');
    // Old file remains preserved (never deleted)
    expect(readFileSync(first.light, 'utf8')).toBe('<svg id="v1"/>');
  });

  it('light and dark entries are the same path', () => {
    const p = paths();
    expect(p.light).toBe(p.dark);
  });

  it('the brand path never equals a glyph path', () => {
    const p = paths();
    const gray = glyphIconPath('gray', { storageDir, assetSvgPath: ASSET });
    expect(p.light).not.toBe(gray);
    expect(p.dark).not.toBe(gray);
  });

  it('a glyph file contains the tinted mark, not the raw asset', () => {
    const raw = readFileSync(ASSET, 'utf8');
    expect(raw).toContain('currentColor');
    const gray = glyphIconPath('gray', { storageDir, assetSvgPath: ASSET });
    const content = readFileSync(gray, 'utf8');
    expect(content).not.toBe(raw);
    expect(content).toContain('#7f8896');
    expect(content).not.toContain('currentColor');
  });

  it('regression test with a temp source: write a file, call, rewrite it with different geometry, call again, assert path1 !== path2 and the second file contains the new geometry', () => {
    const tmpSource = join(storageDir, 'mark-source.svg');
    const geom1 = '<svg><path d="M 1 1"/></svg>';
    const geom2 = '<svg><path d="M 2 2"/></svg>';
    writeFileSync(tmpSource, geom1, 'utf8');

    const path1 = brandIconPaths({ storageDir, assetSvgPath: tmpSource });
    expect(readFileSync(path1.light, 'utf8')).toBe(geom1);

    writeFileSync(tmpSource, geom2, 'utf8');
    const path2 = brandIconPaths({ storageDir, assetSvgPath: tmpSource });

    expect(path1.light).not.toBe(path2.light);
    expect(readFileSync(path2.light, 'utf8')).toBe(geom2);
    expect(readFileSync(path1.light, 'utf8')).toBe(geom1);
  });
});
