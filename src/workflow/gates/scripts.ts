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
 * The default review gates (probed when `review.gates` is absent — Task 9's
 * manifest surface lets a project declare its own instead). Each names the
 * script it depends on, because a gate is only answerable by a repo that
 * defines it: `npm run lint` in a repo with no lint script exits 1 with
 * "Missing script", which says something about the repo's configuration and
 * nothing about the ticket's code.
 *
 * `test` is deliberately ABSENT — it used to be here, duplicating UAT's own
 * gate list (`UAT_GATES` below) so that a repo whose only script was `test`
 * had every review gate silently asking the exact question UAT already
 * answered on the same worktree. That duplication is what `requireIndependentSignal`
 * (R7, `review/aggregate.ts`) exists to catch; removing `test` here closes it
 * at the source instead of only failing the ticket downstream. `build` is
 * added in its place: "does the change compile/bundle" is a property of the
 * diff, not of a running system, and is not asked anywhere else.
 */
export const REVIEW_GATES: readonly GateSpec[] = [
  { name: 'lint', script: 'lint', args: ['run', 'lint'] },
  { name: 'typecheck', script: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'build', script: 'build', args: ['run', 'build'] },
  { name: 'format', script: 'format', args: ['run', 'format'] },
];

/**
 * The scripts review probes a repository for when it has no declared gates,
 * cheapest first — review's value for `resolveGates`' `probeList` parameter
 * (`gates/resolve.ts`), the counterpart of UAT's `PROBE_SCRIPTS`.
 *
 * Derived from `REVIEW_GATES` rather than written out again, so the review gate
 * list has exactly one definition and cannot answer two different questions
 * depending on which constant a caller reached for.
 */
export const REVIEW_PROBE_SCRIPTS: readonly string[] = REVIEW_GATES.map((gate) => gate.script);

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
