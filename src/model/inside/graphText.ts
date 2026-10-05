/** Leaf module: the one audited text sanitizer for graph-derived strings. */

/** Cap for graph-derived text after sanitization. */
export const GRAPH_TEXT_MAX = 200;

/**
 * The one audited escaper for graph-derived text. Untrusted planner/authored
 * prose may contain anything; the projection renders TEXT, never markup.
 */
export function sanitizeGraphText(raw: string): string {
  return raw
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/(?:javascript|vbscript|data):/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, GRAPH_TEXT_MAX);
}
