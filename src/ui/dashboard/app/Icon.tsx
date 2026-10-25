/**
 * A glyph from the injected Tabler catalog (docs/ui/ICONS.md §3) through the design-system
 * runtime's `karstIcon`, mirroring sidebar `Icon.tsx`. The catalog hands back a static,
 * trusted `<svg>` string; this splits it into the `<svg>` element React owns and its path
 * children, so the DOM is the catalog's markup exactly, with no wrapper element.
 * With `AgentIcon.tsx`, the sanctioned raw-HTML site of the dashboard app.
 */
import { memo } from 'react';

const SVG_RE = /^<svg class="([^"]*)" width="([^"]*)" height="([^"]*)" viewBox="([^"]*)"[^>]*>([\s\S]*)<\/svg>$/;

const catalogIcon = (name: string, size?: number): string =>
  (globalThis as unknown as { karstIcon?: (name: string, size?: number) => string }).karstIcon?.(name, size) ?? '';

export const Icon = memo(function Icon({ name, size }: { readonly name: string; readonly size?: number }) {
  const m = SVG_RE.exec(catalogIcon(name, size));
  if (!m) return null;
  return (
    <svg
      className={m[1]}
      width={m[2]}
      height={m[3]}
      viewBox={m[4]}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: m[5]! }}
    />
  );
});
