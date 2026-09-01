import type { BlockerKind, Verdict } from '../../model/types.js';
import type { GateRun } from '../../store/gateRuns.js';
import type { FindingInput } from '../../store/reviewFindings.js';
import type { Severity } from '../../manifest/types.js';
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

/**
 * What the findings lane (Lane B) contributed to THIS run, as an argument
 * `aggregateReview` reads — never fetched by the aggregate itself, which stays
 * pure (§ task 13).
 *
 * - `not-run`: `review.findings.enabled` is false, OR the lane was never
 *   invoked because R3/R4/R5 already decided the run's outcome before any AI
 *   call would have been made (`stages/review.ts` — "a gate failure
 *   short-circuits before any AI call is made", spec §8.14) — indistinguishable
 *   from "disabled" at this layer on purpose: neither contributes evidence to
 *   R6.
 * - `capability-missing`: `findings.enabled` is true but no agent core was
 *   available to ask (spec §8.14) — environmental, not a code defect, so it
 *   parks rather than failing.
 * - `ran`: the lane executed for at least one target and parsed whatever
 *   findings it could out of the raw output (possibly zero — a clean review is
 *   silent, not `not-run`). A call that threw or returned unparseable garbage
 *   also reports `ran` with whatever it did manage to parse (often `[]`): the
 *   lane must not be able to break the stage, so a failed/garbage call still
 *   lets the run reach a verdict decided by the gates (R7/R9), never a park.
 *   The optional `crashes` member (Task 8) carries the collapsed one-line
 *   boundary diagnostics of any target whose call THREW, so the stage can
 *   distinguish "the agent looked and found nothing" from "the agent could not
 *   be asked" — the crash still never fails the stage, but it is recorded
 *   (`execution-failed` on the process run) rather than read as a clean
 *   review. `processRunId` (Task 8) names the Review findings process run the
 *   lane opened, when the caller supplied a process and the lane actually ran.
 * - `stopped`: the run's signal aborted during the lane (before the first
 *   target or between two calls) — an explicit cancellation, never a silently
 *   truncated `ran`. The caller (`stages/review.ts`) MUST close the open
 *   process run as interrupted and return `{kind:'stopped'}` BEFORE calling
 *   `aggregateReview` or constructing any recovery trigger: a stopped lane is
 *   not evidence, and this union deliberately carries no aggregate verdict for
 *   it.
 */
export type FindingsLaneOutcome =
  | { kind: 'not-run' }
  | { kind: 'capability-missing'; reason: string }
  | {
      kind: 'ran';
      findings: readonly FindingInput[];
      /** One collapsed one-line diagnostic per target whose call THREW. Absent = every call succeeded. */
      crashes?: readonly string[];
      /**
       * Repos whose call returned output no findings-shaped container could be
       * read out of. Distinct from a clean review (`findings: []` with nothing
       * here): a review whose ONLY answer was unreadable has produced no
       * signal at all, and reading that as a pass is the vacuous green R6
       * exists to prevent.
       */
      unreadable?: readonly string[];
      /**
       * Total targets the lane asked. Required so R6b can tell "every target
       * was unreadable" (block — no signal at all) apart from "one target was
       * unreadable, the rest legitimately answered clean" (a genuine pass for
       * the clean targets must not be discarded because one repo's core
       * misbehaved).
       */
      targetCount: number;
      /** The Review process run this invocation opened; absent = none was opened. */
      processRunId?: number | null;
    }
  | {
      kind: 'stopped';
      /** One bounded reason; the caller folds it into the stopped notes. */
      reason: string;
      /** The Review process run this invocation opened; the caller interrupts it. Absent = none was opened. */
      processRunId?: number | null;
    };

export interface AggregateReviewOpts {
  /**
   * Whether review must ask at least one question UAT did not (R7). A violation
   * is a FAILURE, not a warning — unlike UAT, review has a same-day escape
   * hatch in configuration, and this flag is it.
   */
  requireIndependentSignal: boolean;
  /**
   * `review.findings.blockingSeverity` (manifest). `'none'` disables R6
   * entirely — findings are still recorded as evidence, they just never fail a
   * ticket. Otherwise a finding at or above this severity fails review.
   */
  findingsBlockingSeverity: Severity | 'none';
  /**
   * The gate names this ticket switched off. Not evidence — the skipped rows in
   * `gate_runs` are — but the one fact that lets R3's block NAME why nothing
   * ran: "the repository offered nothing" vs "the user disabled everything
   * that was offered". Both are still blocks; a per-ticket disable does not
   * soften R3, it only names it correctly.
   */
  disabledGateNames?: readonly string[];
}

/**
 * The default when `manifest.review` is absent, or present without this key
 * (`stages/review.ts` reads `manifest?.review?.requireIndependentSignal ?? `
 * this constant). `true`: a review that re-asks only UAT's questions has added
 * no signal, and reading that as green is the vacuous pass this whole redesign
 * exists to close.
 */
export const DEFAULT_REQUIRE_INDEPENDENT_SIGNAL = true;

/**
 * The default when `manifest.review` (or `manifest.review.findings`) is
 * absent — `validateReview` returns `undefined` for a manifest with no
 * `review:` key at all, so a REAL loaded manifest can carry this same
 * absence, exactly like `requireIndependentSignal` above. Mirrors
 * `manifest/validate/review.ts`'s `defaultFindings()` and
 * `manifest/fixtures.ts`'s `review()` builder — kept a separate literal
 * rather than a shared import so `manifest/` never depends on `workflow/`.
 * The human-decided default (constraints.md): the lane is ON, and
 * critical/high findings fail review until the lane is proven out.
 */
export const DEFAULT_REVIEW_FINDINGS = {
  enabled: true,
  blockingSeverity: 'high',
  maxFindings: 50,
} as const;

/**
 * The reason prefix of R6's failure — the ONE thing that tells a failed review
 * verdict "this was the findings lane" apart from "a gate failed". Authored
 * here (R6 below) and read back by `stages/review.ts` when it classifies the
 * verdict into a recovery trigger — a shared constant, never a second string.
 */
export const FINDINGS_FAILURE_PREFIX = 'review findings: ';

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
 * R1–R5, in precedence order, first match wins. Exported so `stages/review.ts`
 * can ask the SAME question `aggregateReview` will ultimately ask — "has the
 * outcome already been decided before R6?" — without restating the rules, so it
 * knows whether to spend an AI call on the findings lane at all (spec §8.14:
 * "If gates already produced a failure, R5 wins and no agent call is made at
 * all"). Returns `null` when none of R3–R5 apply, meaning R6 onward still gets
 * to decide.
 *
 * R1 (no target resolved) and R2 (a probe karst could not read) are decided by
 * `stages/review.ts` BEFORE a single entry exists, so they are not repeated
 * here — this function is never reached in those cases either.
 */
export function gatesOutcomeBeforeFindings(
  entries: readonly AggregateEntry[],
  /**
   * The gate names this ticket switched off (`AggregateReviewOpts.disabledGateNames`).
   * When all gates are deliberately disabled, review passes: the user explicitly
   * chose to skip every check, which is a valid configuration. When gates were
   * never resolved (no entries, no disables), the stage blocks.
   */
  disabledNames: readonly string[] = [],
): AggregateOutcome | null {
  const ran = entries.filter((e) => e.result.exitCode !== null);

  if (ran.length === 0) {
    // All gates deliberately disabled by the user — pass.
    if (entries.length === 0 && disabledNames.length > 0) {
      return { kind: 'verdict', verdict: { kind: 'passed' }, warnings: [] };
    }
    // R3 — nothing answered. Not a pass: converting "asked nothing" into green
    // is the bug this design exists to close.
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

  return null;
}

/** Rank for severity comparisons — lower is worse. Mirrors `findings.ts`'s truncation rank, kept local so the pure aggregate has no dependency on the untrusted-input parser. */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const SEVERITIES_BY_RANK: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** "2 critical, 1 high" — grouped and ordered worst-first, regardless of report order. */
function summarizeSeverities(findings: readonly FindingInput[]): string {
  const counts = new Map<Severity, number>();
  for (const f of findings) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  return SEVERITIES_BY_RANK.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(', ');
}

/**
 * Reduce one review run to one outcome. **This is the only place review's
 * verdict is stated**, and it is pure: no store, no clock, no filesystem, and it
 * mutates none of its inputs.
 *
 * §6.4's R1–R9 in precedence order, first match wins. R1 and R2 are decided by
 * `stages/review.ts` before a single entry exists (see `gatesOutcomeBeforeFindings`).
 * R8 (human approval) was dropped from this plan and has no state.
 *
 * No rule here can be satisfied by an agent asserting anything: every input is
 * an exit code, a probe result, a parsed-and-validated finding, or a row karst
 * itself wrote. `findingsLane` in particular is DATA the reduction reads, never
 * a verdict the agent issues (§7.2) — an agent cannot make `aggregateReview`
 * pass by claiming anything; it can only add evidence that a THRESHOLD
 * configured by the human (`findingsBlockingSeverity`) then judges.
 */
export function aggregateReview(
  entries: readonly AggregateEntry[],
  uatIdentities: readonly GateIdentity[],
  findingsLane: FindingsLaneOutcome,
  opts: AggregateReviewOpts,
): AggregateOutcome {
  const ran = entries.filter((e) => e.result.exitCode !== null);

  // R3/R4/R5 — see `gatesOutcomeBeforeFindings`.
  const gateOutcome = gatesOutcomeBeforeFindings(entries, opts.disabledGateNames ?? []);
  if (gateOutcome) return gateOutcome;

  // R6 — findings. `not-run` (disabled, or the lane was skipped because R3–R5
  // already decided) falls through untouched: no stubbed lane can fail a
  // ticket on evidence nothing produced. `capability-missing` parks — the
  // agent core could not be asked, which is environmental, not a code defect
  // (§8.14). `ran` blocks only when at least one finding meets or exceeds the
  // configured threshold; `'none'` disables the check but the findings still
  // reached the store as evidence (recorded by the caller, not read again here).
  if (findingsLane.kind === 'capability-missing') {
    return { kind: 'blocked', blocker: 'capability-missing', reason: findingsLane.reason };
  }
  // R6b — the lane ran, the threshold is on, and EVERY target's answer was
  // unreadable — not merely one of several. Blocked, not failed: an
  // unreadable answer is the core misbehaving, not the code being wrong, so
  // it must not spend a fix round. Gated on `targetCount`, not on
  // `findings.length === 0` alone: a lane with two targets where one is
  // unreadable and the other genuinely answered clean also has zero
  // findings, but that clean target's real pass must not be discarded
  // because a sibling repo's core misbehaved.
  if (
    findingsLane.kind === 'ran' &&
    opts.findingsBlockingSeverity !== 'none' &&
    (findingsLane.unreadable?.length ?? 0) > 0 &&
    (findingsLane.unreadable?.length ?? 0) >= findingsLane.targetCount &&
    findingsLane.findings.length === 0
  ) {
    return {
      kind: 'blocked',
      blocker: 'capability-missing',
      reason: `${FINDINGS_FAILURE_PREFIX}unreadable output from ${(findingsLane.unreadable ?? []).join(', ')} — no findings could be read`,
    };
  }
  if (findingsLane.kind === 'ran' && opts.findingsBlockingSeverity !== 'none') {
    const threshold = SEVERITY_RANK[opts.findingsBlockingSeverity];
    const blocking = findingsLane.findings.filter((f) => SEVERITY_RANK[f.severity] <= threshold);
    if (blocking.length > 0) {
      return {
        kind: 'verdict',
        verdict: {
          kind: 'failed',
          reason: `${FINDINGS_FAILURE_PREFIX}${summarizeSeverities(blocking)}`,
        },
        warnings: [],
      };
    }
  }

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
