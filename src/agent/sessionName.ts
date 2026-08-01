/**
 * The display name an interactive agent session launches under.
 *
 * It is the SAME string the terminal tab shows (rendered from the manifest's
 * `terminalNameTemplate`), so a session found later in the agent's own resume
 * picker carries the ticket it belonged to instead of a summary of its first
 * message. The value is ticket prose — a title karst did not author — and it
 * reaches the agent as argv, so it is collapsed to one bounded line here, at
 * the one boundary that emits it.
 *
 * vscode-free and pure.
 */

/** Longest name passed to an agent CLI — a picker row, not a description. */
export const SESSION_NAME_MAX = 120;

/** Anything that would break a single-line picker row: controls and newlines. */
const CONTROL_OR_SPACE = /[\p{Cc}\p{Cf}\s]+/gu;

/**
 * Collapse a rendered display name into a one-line, length-bounded session
 * name. Returns `undefined` when nothing renderable is left — the caller then
 * omits the flag entirely and the agent keeps its own default naming.
 */
export function sanitizeSessionName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const collapsed = raw.replace(CONTROL_OR_SPACE, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.slice(0, SESSION_NAME_MAX);
}
