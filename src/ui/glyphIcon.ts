import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Glyph } from '../model/glyph.js';
import { glyphHex } from '../model/glyphColor.js';

/** Bake a color into an SVG authored with `stroke="currentColor"` (pure). */
export function tintSvg(svg: string, hex: string): string {
  return svg.replaceAll('currentColor', hex);
}

/**
 * Materialize the karst logo tinted for `glyph` into `<storageDir>/icons/` and
 * return its path (for `iconPath`). Idempotent — written once per glyph.
 * `iconPath` renders a static image VS Code will not theme-tint, so the hue is
 * baked here rather than passed as a ThemeColor.
 */
export function glyphIconPath(
  glyph: Glyph,
  opts: { storageDir: string; assetSvgPath: string },
): string {
  const dir = join(opts.storageDir, 'icons');
  const file = join(dir, `karst-${glyph}.svg`);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(opts.assetSvgPath, 'utf8');
  writeFileSync(file, tintSvg(src, glyphHex(glyph)), 'utf8');
  return file;
}
