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
  { pattern: /base check skipped: some vitest failures are not parseable/i, reason: 'the base check could not parse the vitest failures' },
  { pattern: /not (?:a )?screenshot mismatch/i, reason: 'a failure that is not a screenshot mismatch' },
  { pattern: /screenshots fail \(cap \d+\)/i, reason: MORE_THAN_CAP },
  { pattern: /no free window of/i, reason: 'no free port window' },
];

/** The reason a failed gate's output looks like an environment fault, or null. */
export function environmentSignature(_gateName: string, output: string): string | null {
  const plain = output.replace(ANSI_RE, '');
  for (const { pattern, reason } of SIGNATURES) if (pattern.test(plain)) return reason;
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
