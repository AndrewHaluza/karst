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
 * The capability gaps among a run's gates, or null when there are none.
 *
 * Only gates that RAN are considered: a gate that never ran (no script, no
 * question) says nothing about the environment.
 */
export function capabilityGap(results: readonly GateResult[]): CapabilityGap | null {
  const gaps = results.filter((r) => r.exitCode === EXIT_COMMAND_NOT_FOUND);
  if (gaps.length === 0) return null;
  const names = gaps.map((r) => r.name);
  const detail = gaps
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
