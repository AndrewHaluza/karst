/**
 * The bounded failure summary persisted on a FAILED gate's `gate_runs` row
 * (v46), and the one derivation that turns a gate's raw output into data.
 *
 * A gate's combined output is written only to the artifact log, whose text
 * format is not a data contract — so a failed gate read back out of the store
 * said only `exit 1`, the ticket context rendered the bare verdict string, and
 * a fix session had to open the log to learn the actual Prettier/ESLint/test
 * failure (the "what failed (file, line, rule)" the report asks for). This
 * function is that bridge: a pure, bounded excerpt captured at the moment the
 * gate's row is appended, so the summary is evidence a session can read.
 *
 * It is deliberately a TAIL of non-empty lines: failure tooling prints the
 * actionable errors last (Prettier names the offending file after its
 * "Checking formatting..." preamble, a test runner prints the failing asserts
 * at the end), and the whole output is already in the artifact for the
 * unbounded view. Bounded because `gate_runs` is append-only evidence read by
 * every surface — a summary must never be the thing that blows a context
 * render or a seed.
 *
 * Pure (no store, no fs) so the wording is unit-tested.
 */

/** How many trailing non-empty output lines the summary keeps. */
export const MAX_GATE_SUMMARY_LINES = 12;

/** Total cap on the rendered summary text. */
export const MAX_GATE_SUMMARY_CHARS = 600;

/**
 * A bounded excerpt of a failing gate's output, or null when the output is
 * empty or all whitespace (nothing useful to carry). Only ever called for a
 * gate that FAILED — a pass has no failure to summarize.
 */
export function summarizeGateFailure(output: string): string | null {
  if (!output) return null;
  const nonEmpty: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) nonEmpty.push(line);
  }
  if (nonEmpty.length === 0) return null;
  const tail = nonEmpty.slice(-MAX_GATE_SUMMARY_LINES);
  let text = tail.join('\n');
  if (text.length > MAX_GATE_SUMMARY_CHARS) {
    // Keep the END (the actionable errors), prefixing a marker so a reader
    // knows the head was cut.
    text = `…${text.slice(-(MAX_GATE_SUMMARY_CHARS - 1))}`;
  }
  return text;
}
