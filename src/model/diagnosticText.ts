/**
 * Collapse-and-cap for untrusted diagnostic prose — git stderr, gate output,
 * a park's blocker reason — before it reaches ANY rendered surface: a stage
 * verdict, the blocked banner, the ops row that echoes it, a log line, a
 * toast. Such text is unbounded, can be multi-line, and can even contain
 * model output, so it must never reach the DOM raw.
 *
 * Same shape as the private `oneLine`/`cap` pair `agent/cliFailure.ts`
 * already used for a failed headless run's diagnostic text. Pulled out here
 * so a second call site (a stage's `reason`/`blocked.reason`, built in
 * `model/stepper.ts`) shares one implementation instead of growing its own —
 * `cliFailure.ts` now imports this instead of keeping a private copy.
 */

/** Matches the bound `agent/cliFailure.ts` already used for raw CLI text. */
export const MAX_DIAGNOSTIC_CHARS = 8_000;

/** One line, no runs of whitespace — a rendered surface is not a log viewer. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate to `max` characters, marking the cut with an ellipsis. */
export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Collapse to one line, THEN cap — in that order, so a huge run of
 * whitespace in the raw text cannot exhaust the character budget before the
 * collapse ever runs.
 */
export function collapseDiagnostic(text: string, max: number = MAX_DIAGNOSTIC_CHARS): string {
  return cap(oneLine(text), max);
}
