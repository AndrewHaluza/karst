import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Glyph } from '../model/glyph.js';
import { glyphHex } from '../model/glyphColor.js';

/** Bake a color into an SVG authored with `currentColor` (pure). */
export function tintSvg(svg: string, hex: string): string {
  return svg.replaceAll('currentColor', hex);
}

/**
 * Materialize the karst logo tinted for `glyph` into `<storageDir>/icons/` and
 * return its path (for `iconPath`). Content-addressed: the path embeds the
 * first 8 hex characters of the SHA-256 hash of the tinted SVG bytes.
 * Idempotent — the same tinted bytes yield the same path and skip rewriting.
 * `iconPath` renders a static image VS Code will not theme-tint, so the hue is
 * baked here rather than passed as a ThemeColor.
 */
export function glyphIconPath(
  glyph: Glyph,
  opts: { storageDir: string; assetSvgPath: string },
): string {
  const dir = join(opts.storageDir, 'icons');
  const src = readFileSync(opts.assetSvgPath, 'utf8');
  const tinted = tintSvg(src, glyphHex(glyph));
  const hash = createHash('sha256').update(tinted, 'utf8').digest('hex').slice(0, 8);
  const file = join(dir, `karst-${glyph}-${hash}.svg`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, tinted, 'utf8');
  }
  return file;
}
