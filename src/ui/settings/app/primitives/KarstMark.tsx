/**
 * The Karst brand mark, inline (ICONS-05 exception: an identity mark, not a
 * Tabler interaction icon). Marks values Karst supplies itself — the built-in
 * profile and the "default" source. Decorative: callers carry the text.
 */
export function KarstMark({ size = 14 }: { readonly size?: number }) {
  return (
    <svg className="k-karst-mark" viewBox="0 0 215 215" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z" fill="currentColor" />
      <path d="M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z" fill="currentColor" />
      <circle cx="106.5" cy="111.5" r="26.5" fill="currentColor" />
    </svg>
  );
}
