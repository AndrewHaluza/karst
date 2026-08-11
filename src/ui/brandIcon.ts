import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The karst mark for tabs that carry NO status — settings, usage, changes,
 * welcome, and a create-mode ticket form with no ticket bound yet. Those
 * panels have nothing for the status ramp to say, so the mark is rendered in
 * its approved full-color treatment rather than in a glyph hue: a Settings tab
 * tinted `gray` would read as an idle ticket.
 *
 * One materialized file serves both entries of the `{light, dark}` pair that
 * `iconPath` takes: the approved #35 mark carries its own colors, chosen to
 * contrast on both themes, so no per-theme foreground is baked (the old
 * monochrome mark needed one).
 */
export interface BrandIconPaths {
  light: string;
  dark: string;
}

/**
 * Materialize the full-color karst mark into `<storageDir>/icons/` once and
 * return both theme paths (for `iconPath`). Idempotent — an existing file is
 * returned as-is, exactly like `glyphIconPath`.
 */
export function brandIconPaths(opts: {
  storageDir: string;
  assetSvgPath: string;
}): BrandIconPaths {
  const dir = join(opts.storageDir, 'icons');
  const file = join(dir, 'karst-brand.svg');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, readFileSync(opts.assetSvgPath, 'utf8'), 'utf8');
  }
  return { light: file, dark: file };
}
