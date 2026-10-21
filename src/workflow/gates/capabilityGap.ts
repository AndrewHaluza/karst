import { MAX_GATE_SUMMARY_CHARS, summarizeGateFailure } from '../../model/gateSummary.js';
import type { GateResult } from './result.js';

/**
 * POSIX's "command not found" exit code (127).
 *
 * A gate that ends with it did not FAIL: the binary it runs is not installed
 * in this environment. That is a missing capability, not a defect in the
 * ticket's code — the same distinction the UAT stage already draws for a
 * dependency tree that drifted from the lockfile ("a SETUP failure ... the
 * caller parks instead of returning a test verdict").
 */
export const EXIT_COMMAND_NOT_FOUND = 127;

export interface CapabilityGap {
  /** The gates that exited 127, in the order they ran. */
  readonly names: string[];
  /** One sentence naming the gates and the capability they were missing. */
  readonly reason: string;
}

/**
 * The capability gaps among the gates that FAILED, or null when there are none.
 *
 * "All of them" is the rule: the park replaces a failed verdict only when
 * EVERY failure is a missing command. A gate that failed for an ordinary
 * reason (a test assertion, a lint error) is something the ticket can fix,
 * and a capability gap must never swallow it — the failed gate is the
 * actionable one, and its own output is on the recorded row.
 *
 * Only gates that RAN are considered: a gate that never ran (no script, no
 * question) says nothing about the environment.
 */
export function capabilityGap(failed: readonly GateResult[]): CapabilityGap | null {
  if (failed.length === 0) return null;
  if (!failed.every((r) => r.exitCode === EXIT_COMMAND_NOT_FOUND)) return null;
  const names = failed.map((r) => r.name);
  const detail = failed
    .map((r) => summarizeGateFailure(r.output) ?? r.name)
    .join(' | ')
    .slice(0, MAX_GATE_SUMMARY_CHARS);
  const many = names.length > 1;
  return {
    names,
    reason:
      `gate${many ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')} exited ${EXIT_COMMAND_NOT_FOUND} — ` +
      `the command ${many ? 'they run' : 'it runs'} is not installed in this environment: ${detail}`,
  };
}

/**
 * The park reason when any gate was a refused `sandbox: host` gate, else null.
 * A refused host gate never ran, so unlike a ran-and-failed gate it outranks
 * every other result: the verdict would be about a partial run.
 */
export function hostRefusalReason(results: readonly GateResult[]): string | null {
  const refused = results.filter((r) => r.hostRefused === true);
  if (refused.length === 0) return null;
  const detail = refused
    .map((r) => `"${r.name}": ${summarizeGateFailure(r.output) ?? r.output}`)
    .join(' | ')
    .slice(0, MAX_GATE_SUMMARY_CHARS);
  return `host gates not run — ${detail}`;
}
