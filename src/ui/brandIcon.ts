import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tintSvg } from './glyphIcon.js';

/**
 * The karst mark for tabs that carry NO status — settings, usage, changes,
 * welcome, and a create-mode ticket form with no ticket bound yet. Those
 * panels have nothing for the status ramp to say, so the mark is rendered in the
 * editor's own icon foreground rather than in a glyph hue: a Settings tab tinted
 * `gray` would read as an idle ticket.
 *
 * Two variants because a tab icon is a static image VS Code will not theme-tint
 * (the same reason `glyphIconPath` bakes its hue) — `iconPath` accepts a
 * `{light, dark}` pair and VS Code picks per active theme kind.
 */
export const BRAND_ICON_HEX = {
  // VS Code's own monochrome icon foregrounds — deliberately not tokens: a
  // static SVG file cannot read `--k-*`, and these are theme chrome, not UI.
  light: '#424242',
  dark: '#c5c5c5',
} as const;

export interface BrandIconPaths {
  light: string;
  dark: string;
}

/**
 * Materialize the untinted karst logo into `<storageDir>/icons/` once per theme
 * kind and return both paths (for `iconPath`). Idempotent — an existing file is
 * returned as-is, exactly like `glyphIconPath`.
 */
export function brandIconPaths(opts: {
  storageDir: string;
  assetSvgPath: string;
}): BrandIconPaths {
  const dir = join(opts.storageDir, 'icons');
  const write = (theme: keyof typeof BRAND_ICON_HEX): string => {
    const file = join(dir, `karst-brand-${theme}.svg`);
    if (existsSync(file)) return file;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, tintSvg(readFileSync(opts.assetSvgPath, 'utf8'), BRAND_ICON_HEX[theme]), 'utf8');
    return file;
  };
  return { light: write('light'), dark: write('dark') };
}
