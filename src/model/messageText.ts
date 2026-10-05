/**
 * Untrusted mailbox text hygiene (v64). A body is printed into an agent's
 * terminal by `karst inbox`; a control character or a line terminator the
 * quoting does not see could repaint the terminal (ANSI) or forge a frame
 * header ("x\rkarst event: merged"). Writers refuse them; readers defend again
 * for legacy/host rows.
 */

/** C0 except \t and \n, DEL, C1 (incl. U+0085 NEL), U+2028, U+2029. */
const FORBIDDEN_IN_BODY = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/u;

/** Every line terminator a terminal or editor may honor. */
const LINE_BREAK = /\r\n|[\r\n\u000B\u000C\u0085\u2028\u2029]/u;

/** Controls left after splitting (tab kept). */
const STRIP = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/gu;

function codePoint(ch: string): string {
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * The first forbidden character in a body as `U+XXXX`, or null. Newline is
 * allowed (multi-line bodies), so test it separately from the rest of C0.
 */
export function forbiddenBodyChar(body: string): string | null {
  for (const ch of body) {
    if (ch === '\n') continue;
    if (FORBIDDEN_IN_BODY.test(ch)) return codePoint(ch);
  }
  return null;
}

/** Remove every control/line-terminator character (tab kept). */
export function sanitizeInline(text: string): string {
  return text.replace(STRIP, '');
}

/** Quote every line of an untrusted body so none can open a header of its own. */
export function quoteUntrusted(body: string): string {
  return body
    .split(LINE_BREAK)
    .map((line) => `> ${sanitizeInline(line)}`)
    .join('\n');
}
