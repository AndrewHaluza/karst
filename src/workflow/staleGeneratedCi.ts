import { MAX_CI_LOG_CHARS } from './transientCi.js';

/**
 * Stale generated file in CI (T1081, @arch:AP-05): a failed job whose only error is `<path> is stale: run <command>`, where
 * `<command>` is an entry of the repository's `ship.regenerate` list. CI checks the merge of the PR with the CURRENT base, so
 * a base that moved makes a generated file stale only there; a host rebase and regenerate fixes it with no agent.
 *
 * The log is untrusted data: it is bounded, read as text, and only matched against closed patterns. It is never evaluated.
 * A command is never run from the log: it is only compared with the entries of `ship.regenerate`.
 */

/** Prefix of `autopilot_reruns.pattern` for a rebase round (a network re-run stores a pattern id without it). */
export const STALE_PATTERN_PREFIX = 'stale-generated:';

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** `gh run view --log` prefix: `<job>\t<step>\t`. */
const GH_PREFIX = /^[^\t]*\t[^\t]*\t/;
const TIMESTAMP = /^\S+Z\s+/;
const ANNOTATION = /^##\[(?:error|warning)\]/;
const STALE_LINE = /^(\S+) is stale: run (.+?)\s*$/;
/** The runner repeats the exit code of the failed step as an error annotation: it carries no second fault. */
const EXIT_LINE = /^Process completed with exit code \d+\.?$/;
/** A step-level error of a package tool. */
const TOOL_ERROR = /^npm (?:ERR!|error)\b/;
/** Test-runner failure markers: test output is printed without a step prefix, so these are matched on their own. */
const TEST_FAILURE = /^(?:FAIL\b|[×✗]\s)|AssertionError|\b(?:Tests?|Test Files)\s+\d+ failed\b/;

function clean(line: string): string {
  let s = line.replace(ANSI, '').replace(/\r$/, '');
  s = s.replace(GH_PREFIX, '').replace(TIMESTAMP, '').trim();
  return s.replace(ANNOTATION, '').trim();
}

/**
 * The commands named by the stale lines of the log, when the failure is only stale generated files and every command is in
 * `regenerate`. Null otherwise: no stale line, a command that is not in the list, or any other error line.
 */
export function classifyStaleGeneratedLog(log: string, regenerate: readonly string[]): string[] | null {
  if (regenerate.length === 0) return null;
  const tail = log.length > MAX_CI_LOG_CHARS ? log.slice(-MAX_CI_LOG_CHARS) : log;
  const commands: string[] = [];
  for (const raw of tail.split('\n')) {
    const line = clean(raw);
    if (line === '') continue;
    const stale = STALE_LINE.exec(line);
    if (stale) {
      const command = stale[2]!;
      if (!regenerate.includes(command)) return null;
      if (!commands.includes(command)) commands.push(command);
      continue;
    }
    const annotated = ANNOTATION.test(raw.replace(ANSI, '').replace(GH_PREFIX, '').replace(TIMESTAMP, '').trim());
    if (TOOL_ERROR.test(line) || TEST_FAILURE.test(line)) return null;
    if (annotated && !EXIT_LINE.test(line)) return null;
  }
  return commands.length > 0 ? commands : null;
}
