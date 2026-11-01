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

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const LONE_ESC_RE = /\u001b/g;
const FAIL_LINE_RE = /^(?:FAIL|×)\s+(\S.*?)(?:\s+\d+ms)?$/;
const VITEST_FOOTER_RE = /^Test Files\s/;

function cleanLines(output: string): string[] {
  const plain = output.replace(ANSI_RE, '').replace(LONE_ESC_RE, '');
  const lines: string[] = [];
  for (const raw of plain.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) lines.push(line);
  }
  return lines;
}

/**
 * The deduped `<file> > <suite> > <test>` ids of vitest `FAIL` lines in a
 * gate's output (ANSI stripped). Empty for non-vitest output. Pure, for reuse
 * by base-red detection.
 */
export function failingTestIds(output: string): string[] {
  const ids: string[] = [];
  for (const line of cleanLines(output)) {
    const m = FAIL_LINE_RE.exec(line);
    if (m && m[1]!.includes(' > ') && !ids.includes(m[1]!)) ids.push(m[1]!);
  }
  return ids;
}

/**
 * A bounded excerpt of a failing gate's output, or null when the output is
 * empty or all whitespace (nothing useful to carry). Only ever called for a
 * gate that FAILED — a pass has no failure to summarize. ANSI is stripped;
 * for vitest output the failing test ids lead, then the tail fills the rest.
 */
export function summarizeGateFailure(output: string): string | null {
  if (!output) return null;
  const nonEmpty = cleanLines(output);
  if (nonEmpty.length === 0) return null;
  const tail = nonEmpty.slice(-MAX_GATE_SUMMARY_LINES);
  const ids = nonEmpty.some((l) => VITEST_FOOTER_RE.test(l)) ? failingTestIds(output) : [];
  if (ids.length === 0) return capTail(tail.join('\n'));
  const head = ids.map((id) => `FAIL ${id}`).join('\n');
  const room = MAX_GATE_SUMMARY_CHARS - head.length - 1;
  if (room < 40) return head.length > MAX_GATE_SUMMARY_CHARS ? `${head.slice(0, MAX_GATE_SUMMARY_CHARS - 1)}…` : head;
  const rest = tail.filter((l) => !ids.some((id) => l.includes(id))).join('\n');
  return `${head}\n${capTail(rest, room)}`;
}

function capTail(text: string, max = MAX_GATE_SUMMARY_CHARS): string {
  // Keep the END (the actionable errors), prefixing a marker so a reader
  // knows the head was cut.
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}
