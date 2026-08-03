import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { brandIconPaths, BRAND_ICON_HEX } from './brandIcon.js';
import { glyphIconPath } from './glyphIcon.js';

const ASSET = join(dirname(new URL(import.meta.url).pathname), '..', '..', 'media', 'karst.svg');

let storageDir = '';
beforeEach(() => {
  storageDir = mkdtempSync(join(tmpdir(), 'karst-brand-'));
});

const paths = (): { light: string; dark: string } =>
  brandIconPaths({ storageDir, assetSvgPath: ASSET });

describe('brandIconPaths', () => {
  it('materializes a light and a dark variant under <storageDir>/icons', () => {
    const p = paths();
    expect(dirname(p.light)).toBe(join(storageDir, 'icons'));
    expect(dirname(p.dark)).toBe(join(storageDir, 'icons'));
    expect(readFileSync(p.light, 'utf8')).toContain('<svg');
    expect(readFileSync(p.dark, 'utf8')).toContain('<svg');
  });

  // A tab icon is a static image VS Code will not tint, so an untinted
  // `currentColor` renders black — invisible on a dark theme.
  it('bakes a theme foreground into each variant, leaving no currentColor', () => {
    const p = paths();
    expect(readFileSync(p.light, 'utf8')).toContain(BRAND_ICON_HEX.light);
    expect(readFileSync(p.dark, 'utf8')).toContain(BRAND_ICON_HEX.dark);
    expect(readFileSync(p.light, 'utf8')).not.toContain('currentColor');
    expect(readFileSync(p.dark, 'utf8')).not.toContain('currentColor');
  });

  it('gives the two themes different files and different hues', () => {
    const p = paths();
    expect(p.light).not.toBe(p.dark);
    expect(BRAND_ICON_HEX.light).not.toBe(BRAND_ICON_HEX.dark);
  });

  // The brand mark carries no status: it must never resolve to a file the
  // status ramp writes, or a Settings tab would read as an idle ticket.
  it('never collides with a status-tinted glyph icon', () => {
    const p = paths();
    const gray = glyphIconPath('gray', { storageDir, assetSvgPath: ASSET });
    expect([p.light, p.dark]).not.toContain(gray);
    expect(basename(p.light)).toMatch(/^karst-brand-/);
  });

  it('is idempotent — an existing file is returned, not rewritten', () => {
    const first = paths();
    writeFileSync(first.dark, '<svg data-kept="1"/>', 'utf8');
    const second = paths();
    expect(second).toEqual(first);
    expect(readFileSync(second.dark, 'utf8')).toBe('<svg data-kept="1"/>');
  });
});
