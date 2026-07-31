import { probeScripts } from './probe.js';

/** One review gate: a name, the npm script it needs, and how to invoke it. */
export interface GateSpec {
  /** The name the verdict and the log use. */
  name: string;
  /** The package.json script this gate runs — the thing that must exist. */
  script: string;
  /** Args passed to `npm`. */
  args: readonly string[];
}

/**
 * The MVP review gates. Each names the script it depends on, because a gate is
 * only answerable by a repo that defines it: `npm run lint` in a repo with no
 * lint script exits 1 with "Missing script", which says something about the
 * repo's configuration and nothing about the ticket's code.
 */
export const REVIEW_GATES: readonly GateSpec[] = [
  { name: 'lint', script: 'lint', args: ['run', 'lint'] },
  { name: 'typecheck', script: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'test', script: 'test', args: ['test'] },
];

/**
 * The UAT gate list. A list, not a constant: the original bug was that UAT asked
 * exactly ONE question and another stage asked it too, so the fix is not removing
 * `test` — it is giving UAT room to ask more. `test` stays FIRST because it is the
 * conventional entry point and usually the cheapest suite in the repo, and
 * cheapest-first is what makes a failing gate fail fast.
 *
 * Sharing REVIEW_GATES' `test` entry is still true here and still not enough on
 * its own — see `uat/aggregate.ts`, which checks the identities that actually RAN.
 */
export const UAT_GATES: readonly GateSpec[] = [
  { name: 'test', script: 'test', args: ['test'] },
];

/**
 * The `scripts` a repo defines, or `{}` when karst could not read them.
 *
 * Kept for review, which has no place to put a richer answer yet. UAT calls
 * `probeScripts` directly, because "why is this empty" is the whole question
 * there — see `uat/gates.ts`.
 */
export function readPackageScripts(cwd: string): Record<string, string> {
  const probe = probeScripts(cwd);
  return probe.kind === 'ok' ? probe.scripts : {};
}
