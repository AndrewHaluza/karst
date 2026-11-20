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
// Copies of the headers `reportLines` in scripts/vitestDrift.mjs prints (src never imports scripts; a pinning test guards them).
const BREAKS_HEADER_RE = /^ticket breaks \(pass at the base, fail here\) — \d+:$/;
const DRIFT_HEADER_RE = /^base drift \(develop drift, not this ticket\) — \d+:$/;
const SECTION_ITEM_RE = /^- (\S.*)$/;
const DRIFT_MARK = ' (base drift, not this ticket)';

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

/** The deduped ids listed under every section whose header matches `header` (cleaned lines). */
function sectionIds(lines: string[], header: RegExp): string[] {
  const ids: string[] = [];
  lines.forEach((line, i) => {
    if (!header.test(line)) return;
    for (let j = i + 1; j < lines.length; j++) {
      const m = SECTION_ITEM_RE.exec(lines[j]!);
      if (!m) break;
      if (!ids.includes(m[1]!)) ids.push(m[1]!);
    }
  });
  return ids;
}

/**
 * A bounded excerpt of a failing gate's output, or null when the output is
 * empty or all whitespace (nothing useful to carry). Only ever called for a
 * gate that FAILED — a pass has no failure to summarize. ANSI is stripped.
 * For vitest output the failing test ids lead, in this order: the ticket
 * breaks, then the base-drift ids marked "(base drift, not this ticket)",
 * then any other FAIL id, each once; the tail fills the rest. The sections
 * are parsed from the whole output, never from the tail.
 */
export function summarizeGateFailure(output: string): string | null {
  if (!output) return null;
  const nonEmpty = cleanLines(output);
  if (nonEmpty.length === 0) return null;
  const tail = nonEmpty.slice(-MAX_GATE_SUMMARY_LINES);
  const isVitest = nonEmpty.some((l) => VITEST_FOOTER_RE.test(l));
  const breaks = isVitest ? sectionIds(nonEmpty, BREAKS_HEADER_RE) : [];
  const drift = isVitest ? sectionIds(nonEmpty, DRIFT_HEADER_RE).filter((id) => !breaks.includes(id)) : [];
  const others = isVitest ? failingTestIds(output).filter((id) => !breaks.includes(id) && !drift.includes(id)) : [];
  const ids = [...breaks, ...drift, ...others];
  if (ids.length === 0) return capTail(tail.join('\n'));
  const head = [
    ...breaks.map((id) => `FAIL ${id}`),
    ...drift.map((id) => `FAIL ${id}${DRIFT_MARK}`),
    ...others.map((id) => `FAIL ${id}`),
  ].join('\n');
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
