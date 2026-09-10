/**
 * Pure WCAG 2.1 contrast-ratio helpers for the visual sweep's accessibility
 * assertions (UI-R29).
 *
 * These run inside `page.evaluate()` — no Node imports, no Playwright APIs.
 * The functions are self-contained and testable in isolation.
 */

/** Parse a CSS color string to [r, g, b, a] (0-255 for rgb, 0-1 for alpha). */
export function parseCssColor(
  s: string,
): [number, number, number, number] | null {
  s = s.trim().toLowerCase();
  // #hex
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1]!;
    if (h.length === 3) {
      return [
        parseInt(h[0]! + h[0], 16),
        parseInt(h[1]! + h[1], 16),
        parseInt(h[2]! + h[2], 16),
        1,
      ];
    }
    if (h.length === 6) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        1,
      ];
    }
    if (h.length === 8) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
        parseInt(h.slice(6, 8), 16) / 255,
      ];
    }
  }
  // rgb/rgba
  const rgb = s.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)$/,
  );
  if (rgb) {
    return [
      parseInt(rgb[1]!),
      parseInt(rgb[2]!),
      parseInt(rgb[3]!),
      rgb[4] !== undefined ? parseFloat(rgb[4]) : 1,
    ];
  }
  // hsl/hsla (convert to rgb)
  const hsl = s.match(
    /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+))?\s*\)$/,
  );
  if (hsl) {
    const h = parseFloat(hsl[1]!) / 360;
    const sl = parseFloat(hsl[2]!) / 100;
    const l = parseFloat(hsl[3]!) / 100;
    const a = hsl[4] !== undefined ? parseFloat(hsl[4]) : 1;
    let r: number, g: number, b: number;
    if (sl === 0) {
      r = g = b = l;
    } else {
      const hue2rgb = (p: number, q: number, t: number) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + sl) : l + sl - l * sl;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a];
  }
  return null;
}

/** Relative luminance per WCAG 2.1 §1.4.3. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG 2.1 contrast ratio between two relative luminances. */
export function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The required contrast ratio for a text element.
 *
 * UI-R29 explicitly says 14px semibold headings are normal text.
 * Large text: >= 24px, or >= 18.66px at weight >= 700.
 */
export function requiredRatio({
  fontSizePx,
  fontWeight,
}: {
  fontSizePx: number;
  fontWeight: number;
}): number {
  const isLarge =
    fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
  return isLarge ? 3 : 4.5;
}

/**
 * Walk up the ancestor chain to find the effective background color.
 * Returns the first non-transparent, non-null background found.
 */
export function resolveEffectiveBackground(
  el: Element,
): [number, number, number] | null {
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    const bg = getComputedStyle(current).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
      const parsed = parseCssColor(bg);
      if (parsed && parsed[3] > 0) {
        return [parsed[0], parsed[1], parsed[2]];
      }
    }
    current = current.parentElement;
  }
  // Default to white if no background found.
  return [255, 255, 255];
}
