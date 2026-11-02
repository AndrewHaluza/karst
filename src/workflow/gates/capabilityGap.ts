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

const MODULE_NOT_FOUND_RE = /Cannot find module '([^']*[\\/]node_modules[\\/][^']*)'/;
const SRC_STACK_RE = /[\\/]src[\\/]/;

/**
 * The module path when the output is Node's MODULE_NOT_FOUND for a tool under
 * node_modules that the gate LAUNCHED (the command never ran), else null. A
 * requireStack naming a project source file means the ticket's own code
 * imported it: an ordinary failure.
 */
export function launcherModuleNotFound(output: string): string | null {
  if (!output.includes('MODULE_NOT_FOUND')) return null;
  const m = MODULE_NOT_FOUND_RE.exec(output);
  if (!m) return null;
  const stack = output.slice(output.indexOf('requireStack'));
  if (SRC_STACK_RE.test(stack) || /Require stack:[\s\S]*[\\/]src[\\/]/.test(output)) return null;
  return m[1] ?? null;
}

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
  const missing = failed.map((r) => (r.exitCode === EXIT_COMMAND_NOT_FOUND ? null : launcherModuleNotFound(r.output)));
  if (!failed.every((r, i) => r.exitCode === EXIT_COMMAND_NOT_FOUND || missing[i] !== null)) return null;
  const launcher = missing.filter((m): m is string => m !== null);
  const names = failed.map((r) => r.name);
  const detail = failed
    .map((r) => summarizeGateFailure(r.output) ?? r.name)
    .join(' | ')
    .slice(0, MAX_GATE_SUMMARY_CHARS);
  const many = names.length > 1;
  if (launcher.length > 0) {
    return {
      names,
      reason:
        `gate${many ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')} could not launch ${many ? 'their' : 'its'} tool — ` +
        `missing module ${launcher.join(', ')} (run \`npm ci\` in the repo root, or check that the worktree's deps resolve): ${detail}`,
    };
  }
  return {
    names,
    reason:
      `gate${many ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')} exited ${EXIT_COMMAND_NOT_FOUND} — ` +
      `the command ${many ? 'they run' : 'it runs'} is not installed in this environment (install it in sandbox.setup, or mark the gate sandbox: host): ${detail}`,
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

/** The park reason when a gate's script exists on the base but not the ticket branch, else null. */
export function staleBranchReason(results: readonly GateResult[]): string | null {
  const stale = results.filter((r) => r.staleBranch !== undefined);
  if (stale.length === 0) return null;
  // A gate that failed for an ordinary reason is the ticket's to fix and must not be swallowed by the park.
  const ordinaryFailure = results.some(
    (r) => r.staleBranch === undefined && r.exitCode !== null && r.exitCode !== 0,
  );
  if (ordinaryFailure) return null;
  return stale.map((r) => r.staleBranch).join(' | ');
}
