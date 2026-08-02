import type { BlockerKind, Verdict } from '../../model/types.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { AggregateEntry } from '../uat/aggregate.js';

export type { AggregateEntry };

/**
 * What a gate invocation WAS, as review compares its own gates against UAT's.
 *
 * `name` is the recorded `gate_runs.gate_name`; `repo`/`command`/`args` (v21)
 * are the invocation identity and are optional because a row recorded before
 * those columns existed carries none — `uatIdentitiesFrom` maps that row's NULL
 * columns to `undefined` rather than a guess. Review always constructs its own
 * identities with every field present; UAT's side, read back out of the store,
 * may or may not carry them depending on when the row was written.
 * `sameGateIdentity` says exactly how the two are compared either way.
 */
export interface GateIdentity {
  /** `<gate> (<label>)` — the name a stage records for one gate of one target. */
  name: string;
  repo?: string;
  command?: string;
  args?: readonly string[];
}

export type AggregateOutcome =
  | { kind: 'verdict'; verdict: Exclude<Verdict, null>; warnings: string[] }
  | { kind: 'blocked'; blocker: BlockerKind; reason: string };

export interface AggregateReviewOpts {
  /**
   * Whether review must ask at least one question UAT did not (R7). A violation
   * is a FAILURE, not a warning — unlike UAT, review has a same-day escape
   * hatch in configuration, and this flag is it.
   */
  requireIndependentSignal: boolean;
}

/**
 * The default until a manifest key carries it (Task 10). `true`: a review that
 * re-asks only UAT's questions has added no signal, and reading that as green is
 * the vacuous pass this whole redesign exists to close.
 */
export const DEFAULT_REQUIRE_INDEPENDENT_SIGNAL = true;

/**
 * The invocation a malformed-package.json entry claims. Not a real command — it
 * is a synthetic entry standing for "karst could not read this repository's
 * scripts, and that is a defect an agent can fix". Constructed and recognised in
 * this module only, so R4 can outrank R5 without matching on prose.
 */
const PACKAGE_JSON_COMMAND = 'node';
const PACKAGE_JSON_ARG = '--parse-package-json';

/**
 * The entry a target contributes when its `package.json` will not parse.
 *
 * Exit 1, not null: unlike "this repo defines no lint script", a malformed
 * manifest is a repository defect an agent CAN fix, so it must reach a verdict
 * rather than park (mirrors `uat.ts`'s handling of the same probe result).
 */
export function malformedPackageJsonEntry(
  repo: string,
  label: string,
  message: string,
  at: string,
): AggregateEntry {
  return {
    result: {
      name: `package.json (${label})`,
      exitCode: 1,
      output: `package.json is malformed — ${message}`,
      startedAt: at,
      endedAt: at,
    },
    identity: { repo, command: PACKAGE_JSON_COMMAND, args: [PACKAGE_JSON_ARG] },
  };
}

function isMalformedPackageJson(entry: AggregateEntry): boolean {
  return (
    entry.identity.command === PACKAGE_JSON_COMMAND &&
    entry.identity.args.length === 1 &&
    entry.identity.args[0] === PACKAGE_JSON_ARG
  );
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((arg, i) => arg === b[i]);
}

/**
 * Whether two gate invocations are the same question.
 *
 * Compared on the strongest ground BOTH sides carry. `gate_runs` records the
 * invocation as `{repo, command, args}` (v21) — the tuple `uat/aggregate.ts`
 * already uses, and the one that survives a gate being renamed. A row written
 * before those columns existed has none, so the comparison degrades to the
 * recorded name for THAT row, which is why review builds its own identities
 * with the SAME `<gate> (<label>)` naming a stage records — the fallback still
 * has something correct to compare when one side is a legacy row.
 */
export function sameGateIdentity(a: GateIdentity, b: GateIdentity): boolean {
  if (a.command !== undefined && b.command !== undefined) {
    return a.repo === b.repo && a.command === b.command && sameArgs(a.args ?? [], b.args ?? []);
  }
  return a.name === b.name;
}

/** How a gate reads to a person: the command when known, else its recorded name. */
function render(identity: GateIdentity): string {
  if (identity.command === undefined) return identity.name;
  return `${identity.command} ${(identity.args ?? []).join(' ')}`.trim();
}

/** The identity of one review entry — the recorded name plus what review knows. */
function identityOf(entry: AggregateEntry): GateIdentity {
  return {
    name: entry.result.name,
    repo: entry.identity.repo,
    command: entry.identity.command,
    args: entry.identity.args,
  };
}

/**
 * The identities UAT EFFECTIVELY asked, from its latest recorded batch.
 *
 * Latest by the greatest `run_at`, never by array position: `attempt` only
 * increments on a failure, so a fail-then-pass pair shares one, and no query
 * contract guarantees insertion order. Not from a constant either — UAT resolves
 * its gate set at runtime, per repository, so the recorded rows ARE the list.
 *
 * Only gates that RAN count. A UAT gate that never ran asked nothing, so review
 * re-asking it is still review asking something UAT did not.
 */
export function uatIdentitiesFrom(runs: readonly GateRun[]): GateIdentity[] {
  const mine = runs.filter((r) => r.stageKey === 'uat');
  const latest = mine.reduce<string | null>(
    (max, r) => (max === null || r.runAt > max ? r.runAt : max),
    null,
  );
  if (latest === null) return [];
  return mine
    .filter((r) => r.runAt === latest && r.exitCode !== null)
    .map((r) => ({
      name: r.gateName,
      // NULL on a pre-v21 row (never backfilled) maps to undefined, not to an
      // empty/guessed value — `sameGateIdentity` reads undefined as "this side
      // carries nothing richer" and falls back to comparing `name`, which is
      // exactly the degraded comparison this row's actual identity is unknown.
      repo: r.repo ?? undefined,
      command: r.command ?? undefined,
      args: r.args ?? undefined,
    }));
}

/**
 * Reduce one review run to one outcome. **This is the only place review's
 * verdict is stated**, and it is pure: no store, no clock, no filesystem, and it
 * mutates none of its inputs.
 *
 * §6.4's R1–R9 in precedence order, first match wins. R1 (no target resolved) and
 * R2 (a probe karst could not read) are decided by `stages/review.ts` BEFORE a
 * single entry exists — which is precisely their precedence position, since they
 * short-circuit the run before this function is reached. R6 (findings) is Tasks
 * 11–13: there is no findings input yet, so the chain simply falls through it
 * rather than carrying a stub that could fail a ticket on evidence nothing
 * produces. R8 (human approval) was dropped from this plan and has no state.
 *
 * No rule here can be satisfied by an agent asserting anything: every input is
 * an exit code, a probe result, or a row karst itself wrote.
 */
export function aggregateReview(
  entries: readonly AggregateEntry[],
  uatIdentities: readonly GateIdentity[],
  opts: AggregateReviewOpts,
): AggregateOutcome {
  const ran = entries.filter((e) => e.result.exitCode !== null);

  // R3 — nothing answered. Not a pass: converting "asked nothing" into green is
  // the bug this design exists to close.
  if (ran.length === 0) {
    return {
      kind: 'blocked',
      blocker: 'nothing-to-run',
      reason:
        entries.length === 0
          ? 'no gates resolved for this ticket'
          : `no gate ran: ${entries.map((e) => e.result.name).join(', ')}`,
    };
  }

  // R4 — above R5, because "your package.json will not parse" is the actionable
  // sentence; every gate failure downstream of it is a consequence.
  const malformed = ran.filter(isMalformedPackageJson);
  if (malformed.length > 0) {
    return {
      kind: 'verdict',
      verdict: { kind: 'failed', reason: malformed.map((e) => e.result.output).join('; ') },
      warnings: [],
    };
  }

  // R5 — a red gate always wins the wording over R6/R7: gates are cheaper to act on.
  const failing = ran.filter((e) => e.result.exitCode !== 0);
  if (failing.length > 0) {
    return {
      kind: 'verdict',
      verdict: {
        kind: 'failed',
        reason: `gates failed: ${failing.map((e) => e.result.name).join(', ')}`,
      },
      warnings: [],
    };
  }

  // R6 — findings (Tasks 11–13). No input, so nothing matches here yet.

  // R7 — EFFECTIVE identities, never declared ones: a static comparison of
  // configured lists passes for a repository where everything else was skipped.
  if (opts.requireIndependentSignal) {
    const identities = ran.map(identityOf);
    const independent = identities.filter(
      (identity) => !uatIdentities.some((uat) => sameGateIdentity(uat, identity)),
    );
    if (independent.length === 0) {
      return {
        kind: 'verdict',
        verdict: {
          kind: 'failed',
          reason:
            'review asked no question uat does not: ' +
            identities.map(render).join(', '),
        },
        warnings: [],
      };
    }
  }

  // R9.
  return { kind: 'verdict', verdict: { kind: 'passed' }, warnings: [] };
}
