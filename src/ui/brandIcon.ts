import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The karst mark for tabs that carry NO status — settings, usage, changes,
 * welcome, and a create-mode ticket form with no ticket bound yet. Those
 * panels have nothing for the status ramp to say, so the mark is rendered in
 * its approved brand treatment rather than in a glyph hue: a Settings tab
 * tinted `gray` would read as an idle ticket.
 *
 * One materialized file serves both entries of the `{light, dark}` pair that
 * `iconPath` takes: the mark is authored `fill="currentColor"`, and VS Code
 * tints it for the active theme, so no per-theme foreground is baked.
 */
export interface BrandIconPaths {
  light: string;
  dark: string;
}

/**
 * Materialize the karst mark into `<storageDir>/icons/` once and return both
 * theme paths (for `iconPath`). Content-addressed: the path embeds the first
 * 8 hex characters of the SHA-256 hash of the raw SVG bytes. Idempotent — the
 * same source bytes yield the same path and skip rewriting.
 */
export function brandIconPaths(opts: {
  storageDir: string;
  assetSvgPath: string;
}): BrandIconPaths {
  const dir = join(opts.storageDir, 'icons');
  const content = readFileSync(opts.assetSvgPath, 'utf8');
  const hash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 8);
  const file = join(dir, `karst-brand-${hash}.svg`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  return { light: file, dark: file };
}
