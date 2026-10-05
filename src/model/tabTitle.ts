/**
 * Longest editor-tab title karst sets. A ticket title can run to a sentence,
 * and VS Code sizes a webview tab to its full title, so one ticket could crowd
 * every other tab off the strip. The tab tooltip is the same string, so the cut
 * text is lost there too — the full title stays on the panel itself.
 */
export const TAB_TITLE_MAX = 40;

/** `text` cut to `TAB_TITLE_MAX` characters (code points) with a trailing ellipsis. */
export function tabTitle(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= TAB_TITLE_MAX) return text;
  return `${chars.slice(0, TAB_TITLE_MAX - 1).join('').trimEnd()}…`;
}
