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
  it('materializes one full-color file under <storageDir>/icons', () => {
    const p = paths();
    expect(dirname(p.light)).toBe(join(storageDir, 'icons'));
    expect(p.light).toBe(p.dark);
    expect(readFileSync(p.light, 'utf8')).toContain('<svg');
  });

  // The approved #35 mark carries its own colors, chosen to contrast on both
  // light and dark themes — the old per-theme foreground bake is gone.
  it('returns the approved mark for both themes, untinted', () => {
    const p = paths();
    const content = readFileSync(p.light, 'utf8');
    expect(content).toContain('M 96 20');
    expect(content).toContain('cx="106.5" cy="111.5" r="26.5"');
    expect(content).not.toContain('currentColor');
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
    expect(basename(p.light)).toMatch(/^karst-brand\.svg$/);
  });

  it('is idempotent — an existing file is returned, not rewritten', () => {
    const first = paths();
    writeFileSync(first.dark, '<svg data-kept="1"/>', 'utf8');
    const second = paths();
    expect(second).toEqual(first);
    expect(readFileSync(second.dark, 'utf8')).toBe('<svg data-kept="1"/>');
  });
});
