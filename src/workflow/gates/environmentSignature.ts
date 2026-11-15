import { MAX_GATE_SUMMARY_CHARS, summarizeGateFailure } from '../../model/gateSummary.js';

/**
 * A failed gate whose output names an environment fault (a timeout, a port window, a crashed
 * sweep) is likely to pass when the host runs it again. This classifier is pure: it reads the
 * gate's whole output and returns the reason, or null for a failure that needs an agent
 * (a normal assertion, a lint rule, a type error).
 */

/** The line that leads a stored failure summary when the gate output has a signature. */
export const ENVIRONMENT_SIGNATURE_PREFIX = 'environment signature:';

const MORE_THAN_CAP = 'more than 40 failing screenshots (the host environment is suspect)';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const SIGNATURES: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /exceeded the test timeout/i, reason: 'a gate or test timeout' },
  { pattern: /timed out waiting \d+\s*ms from config\.webServer|webServer.{0,40}time(?:d )?out/i, reason: 'a gate or test timeout' },
  // Scoped to the fixture step and to a spawnSync call: a bare ETIMEDOUT can sit in a test title.
  { pattern: /Failed to generate fixtures:.{0,300}ETIMEDOUT|spawnSync\s+\S+\s+ETIMEDOUT/is, reason: 'a gate or test timeout' },
  { pattern: /config\.webServer was not able to start/i, reason: 'the gate web server could not start' },
  // Before the parse line: a suite-level FAIL has no test id, so both lines print and the port window is the cause.
  { pattern: /no free window of/i, reason: 'no free port window' },
  { pattern: /base check skipped: some vitest failures are not parseable/i, reason: 'the base check could not parse the vitest failures' },
  { pattern: /not (?:a )?screenshot mismatch/i, reason: 'a failure that is not a screenshot mismatch' },
  { pattern: /screenshots fail \(cap \d+\)/i, reason: MORE_THAN_CAP },
];

/** The gate runner's own timeout line (`src/workflow/gates/run.ts`). */
const GATE_TIMEOUT_RE = /Command timed out after \d+\s*ms/;
// Same shapes as DIFF_LINE (scripts/visual-sweep-gate.mjs) and FAIL_LINE (scripts/vitestDrift.mjs).
// src does not import scripts/, so the two regexes are copied. Keep them in step.
const SCREENSHOT_DIFF_RE = /(\d+ pixels? \(ratio [\d.]+[^)]*\) are different|Expected an image [^\n]+)/;
const TEST_FAIL_LINE_RE = /^(?:FAIL|×)\s+(\S.*?)(?:\s+\d+ms)?$/;

// Playwright list reporter: a failed test mark (`✘  12 [project] › file`), a numbered failure
// header (`1) [project] › file`) and the `N failed` summary line.
const PLAYWRIGHT_FAIL_LINE_RES: readonly RegExp[] = [
  /^[✘✗×]\s+\d+\s+\[/,
  /^\d+\)\s+\[[^\]]+\]\s+›/,
  /^\d+ failed\b/,
];

/** True when the output holds a real screenshot mismatch or a failing test line. */
function holdsRealFailure(plain: string): boolean {
  if (SCREENSHOT_DIFF_RE.test(plain)) return true;
  return plain.split(/\r?\n/).some((raw) => {
    const line = raw.trim();
    return TEST_FAIL_LINE_RE.test(line) || PLAYWRIGHT_FAIL_LINE_RES.some((re) => re.test(line));
  });
}

const GATE_TIMEOUT_REASON = 'the gate timed out with no failing test or screenshot before it';

/** The reason a failed gate's output looks like an environment fault, or null. */
export function environmentSignature(_gateName: string, output: string): string | null {
  const plain = output.replace(ANSI_RE, '');
  for (const { pattern, reason } of SIGNATURES) if (pattern.test(plain)) return reason;
  // A timeout after a real mismatch or a failing test is a ticket failure that needs the agent.
  if (GATE_TIMEOUT_RE.test(plain) && !holdsRealFailure(plain)) return GATE_TIMEOUT_REASON;
  return null;
}

/**
 * The stored failure summary of a failed gate. The signature line leads it, so the fix brief shows
 * it and the pre-brief re-run can read it back from `gate_runs` after the 600-char tail cut it.
 */
export function summarizeWithSignature(gateName: string, output: string): string | null {
  const summary = summarizeGateFailure(output);
  if (summary === null) return null;
  const reason = environmentSignature(gateName, output);
  if (reason === null) return summary;
  const lead = `${ENVIRONMENT_SIGNATURE_PREFIX} ${reason}\n`;
  return `${lead}${summary}`.slice(0, MAX_GATE_SUMMARY_CHARS + lead.length);
}

/** The signature reason a stored summary carries, or null. */
export function signatureOfSummary(summary: string | null | undefined): string | null {
  if (!summary?.startsWith(ENVIRONMENT_SIGNATURE_PREFIX)) return null;
  const line = summary.split('\n', 1)[0]!;
  const reason = line.slice(ENVIRONMENT_SIGNATURE_PREFIX.length).trim();
  return reason === '' ? null : reason;
}
