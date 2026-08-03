/**
 * Collapse-and-cap for untrusted diagnostic prose - git stderr, gate output,
 * a park's blocker reason - before it reaches ANY rendered surface: a stage
 * verdict, the blocked banner, the ops row that echoes it, a log line, a
 * toast. Such text is unbounded, can be multi-line, and can even contain
 * model output, so it must never reach the DOM raw.
 *
 * Same shape as the private `oneLine`/`cap` pair `agent/cliFailure.ts`
 * already used for a failed headless run's diagnostic text. Pulled out here
 * so a second call site (a stage's `reason`/`blocked.reason`, built in
 * `model/stepper.ts`) shares one implementation instead of growing its own -
 * `cliFailure.ts` now imports this instead of keeping a private copy.
 */

/** Matches the bound `agent/cliFailure.ts` already used for raw CLI text. */
export const MAX_DIAGNOSTIC_CHARS = 8_000;

/**
 * Code-point ranges stripped before the whitespace collapse: C0/C1 control
 * characters (excluding tab/LF/CR, which the whitespace collapse already
 * handles) and Unicode bidirectional-override/isolate characters.
 *
 * Built from numeric code points via `String.fromCharCode`, deliberately,
 * rather than a regex literal carrying pasted control/bidi bytes - a
 * regex literal here would itself be exactly the kind of invisible,
 * unauditable-in-a-diff payload this function exists to strip out of
 * OTHER text.
 *
 * - 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F-0x9F: C0/C1 controls and DEL.
 *   This is what makes an ANSI SGR escape (built from ESC, 0x1B) or an
 *   OSC window-title sequence (ESC ... terminated by BEL, 0x07) disappear
 *   - only the escape/terminator bytes are stripped, so any printable
 *   payload around them survives for the collapse step below.
 * - 0x200E-0x200F: LRM/RLM.
 * - 0x202A-0x202E: LRE/RLE/PDF/LRO/RLO bidi overrides.
 * - 0x2066-0x2069: LRI/RLI/FSI/PDI bidi isolates.
 */
const CONTROL_AND_BIDI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];

function buildControlAndBidiPattern(): RegExp {
  const body = CONTROL_AND_BIDI_RANGES.map(([start, end]) =>
    start === end
      ? String.fromCharCode(start)
      : `${String.fromCharCode(start)}-${String.fromCharCode(end)}`,
  ).join('');
  return new RegExp(`[${body}]`, 'g');
}

const CONTROL_AND_BIDI = buildControlAndBidiPattern();

/**
 * One line, no runs of whitespace, no control/ANSI/bidi characters - a
 * rendered surface is not a log viewer or a terminal. Strip BEFORE
 * collapsing so a stripped-out escape sequence cannot leave a stray
 * whitespace gap behind.
 */
export function oneLine(text: string): string {
  return text.replace(CONTROL_AND_BIDI, '').replace(/\s+/g, ' ').trim();
}

/** Truncate to `max` characters, marking the cut with an ellipsis. */
export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Collapse to one line, THEN cap - in that order, so a huge run of
 * whitespace in the raw text cannot exhaust the character budget before the
 * collapse ever runs.
 */
export function collapseDiagnostic(text: string, max: number = MAX_DIAGNOSTIC_CHARS): string {
  return cap(oneLine(text), max);
}
