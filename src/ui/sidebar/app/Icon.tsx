/**
 * Glyphs. Row and toolbar icons come from the injected Tabler catalog
 * (docs/ui/ICONS.md §3) through the design-system runtime's `karstIcon`; the
 * karst mark is the one inline brand glyph (ICONS-05).
 *
 * The catalog hands back a static, trusted `<svg>` string. `Icon` splits it into
 * the `<svg>` element React owns (class, size, viewBox) and its path children,
 * which are set as the element's content — so the DOM is the catalog's markup
 * exactly, with no wrapper element around it.
 */
import { memo } from 'react';
import { ds } from './runtime.js';

const SVG_RE = /^<svg class="([^"]*)" width="([^"]*)" height="([^"]*)" viewBox="([^"]*)"[^>]*>([\s\S]*)<\/svg>$/;

export const Icon = memo(function Icon({ name, size = 13, cls }: { readonly name: string; readonly size?: number; readonly cls?: string }) {
  const m = SVG_RE.exec(ds.icon(name, size, cls));
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

/** The karst brand mark (approved #35 silhouette, monochrome so the status class tints it). */
export function KarstMark() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 215 215" fill="currentColor">
      <path d="M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z" />
      <path d="M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z" />
      <circle cx="106.5" cy="111.5" r="26.5" />
    </svg>
  );
}

/**
 * The shared `[icon] Core · Model` identity (UI-R10c). Its markup is owned by the
 * agent-identity runtime (`agentIdentityHtml`, which escapes its inputs), so the
 * app mounts that string verbatim instead of keeping a second copy of it.
 */
export function AgentIdentity({ provider, model }: { readonly provider: string; readonly model: string | null }) {
  return <div className="peek-agent" dangerouslySetInnerHTML={{ __html: ds.agentIdentityHtml(provider, model, true) }} />;
}

/** Hand-authored toolbar glyph paths (15px, 24-viewBox stroke treatment). */
export function ToolbarGlyph({ paths }: { readonly paths: readonly string[] }) {
  return (
    <svg className="k-icon" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
