import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { Verdict } from '../../model/types.js';
import { setStage, stageAttempt } from '../../store/stages.js';
import { recordGateRun } from '../../store/gateRuns.js';
import { transition } from '../machine.js';
import { nowIso } from '../../model/time.js';
import { REVIEW_GATES } from '../gates/scripts.js';
import { probeScripts } from '../gates/probe.js';
import { runCommand } from '../gates/run.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import type { Manifest } from '../../manifest/types.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { selectReviewTargets } from '../gates/targets.js';
import type { GateResult } from '../gates/result.js';

export type { GateResult };

/**
 * Review stage (§T4.4, §11). MVP gates on the **deterministic signal** — every
 * gate the repo can answer must exit 0 — plus a human diff review. There is
 * no agent-findings concept in MVP (that's the first post-MVP enhancement); the
 * verdict is purely `passed iff every gate exits 0`. The diff is opened for the
 * human regardless of verdict, so they always see what changed.
 */

/** Runs the review gates (lint/typecheck/test); injected for unit tests. */
export type GateRunner = (cwd: string) => Promise<GateResult[]>;

/**
 * Surfaces a target's changes for a human to review; injected. The host's real
 * implementation reveals the ticket's Changes panel (`TicketChangesManager`,
 * itself backed by `vscode.diff` — but only once the human clicks a file row
 * inside it). This function does not itself guarantee a diff editor opened,
 * only that the review surface did — `reviewInside` and the persisted
 * 'changes' evidence describe it that way, deliberately.
 */
export type OpenDiff = (ticketId: number, cwd: string) => void;

export interface RunReviewOpts {
  ticketId: number;
  cwd: string;
  artifactDir: string;
  /**
   * When present, review is repository-aware: only directly changed worktrees
   * and worktrees affected through dependsOn relations are checked.
   * Absent preserves the single-worktree API used by callers without a manifest.
   */
  manifest?: Manifest;
}

export interface ReviewOutcome {
  verdict: Exclude<Verdict, null>;
  artifactPath: string;
  gates: GateResult[];
}

/**
 * Review asked no question about this ticket's code: every gate came back
 * `null` (nothing changed, no relation was affected, or the repo defines none
 * of the review scripts), so there is nothing a `passed` verdict could mean.
 *
 * Thrown, not returned — deliberately and temporarily. `runReview` still
 * returns `ReviewOutcome` for every other path (this task predates the
 * `StageRunResult` refactor); a thrown error is louder than a silent green in
 * the meantime. Task 6 converts this into `{kind:'blocked',
 * blocker:'nothing-to-run', reason}` once `runReview` itself returns
 * `StageRunResult`, and deletes this class — it is exported now only so that
 * task can catch it by type.
 */
export class ReviewAskedNothingError extends Error {
  constructor(
    public readonly ticketId: number,
    reason: string,
  ) {
    super(`review asked nothing about ticket ${ticketId}: ${reason}`);
    this.name = 'ReviewAskedNothingError';
  }
}

/**
 * Default gate runner: lint, typecheck, tests — each via npm scripts, and each
 * run ONLY if the repo defines that script. A gate whose script is absent is
 * skipped, not failed: `npm run lint` in a repo with no lint script exits 1 with
 * "Missing script", which would park every such ticket at fix forever — an
 * unwinnable loop, since the agent cannot fix code that is not broken.
 *
 * A malformed package.json is different: unlike "no lint script", it is a
 * repository defect an agent CAN fix, so it must fail rather than skip — it
 * short-circuits the whole gate list (there is no script list to trust) and
 * reports as its own `package.json` gate, exit 1 (mirrors `uat.ts`'s
 * malformed-package.json handling).
 */
export function makeGateRunner(): GateRunner {
  return async (cwd) => {
    const probe = probeScripts(cwd);
    if (probe.kind === 'malformed') {
      const at = nowIso();
      return [
        {
          name: 'package.json',
          exitCode: 1,
          output: `package.json is malformed — ${probe.message}`,
          startedAt: at,
          endedAt: at,
        },
      ];
    }
    // `absent` and `io-error` both fall through to "no scripts": a missing
    // file is normal, and an unreadable one is environmental — neither is a
    // code defect an agent can act on, unlike `malformed`.
    const scripts = probe.kind === 'ok' ? probe.scripts : {};
    // Sequential, not `Promise.all`: three npm scripts racing in one worktree
    // fight over the same node_modules/build output, and their interleaved
    // output would land in one artifact log unreadable. Each still runs async,
    // so the extension host stays responsive throughout (see `gates/run.ts`).
    const results: GateResult[] = [];
    for (const { name, script, args } of REVIEW_GATES) {
      if (scripts[script] === undefined) {
        results.push({
          name,
          exitCode: null,
          output: `no "${script}" script in package.json — nothing to run`,
        });
        continue;
      }
      // Stamped around the await, not around a sync call: `runCommand` is async
      // precisely so the host's event loop keeps serving hooks while npm runs,
      // so this pair measures the child's wall-clock life, which is what the
      // panel reports. The skipped branch above stamps neither — a gate that
      // never ran has no duration, and a zero-length one would read as a pass.
      const startedAt = nowIso();
      const r = await runCommand('npm', args, cwd);
      results.push({
        name,
        exitCode: r.exitCode,
        output: r.output,
        startedAt,
        endedAt: nowIso(),
      });
    }
    return results;
  };
}

export async function runReview(
  store: Store,
  opts: RunReviewOpts,
  runner: GateRunner = makeGateRunner(),
  // No default no-op: a caller that supplies nothing means nothing opens, and
  // the evidence below must say so — a default that quietly "succeeds" is
  // exactly the lie this closes (openDiff used to default to a no-op that no
  // caller ever replaced, while the row claimed a diff opened regardless).
  openDiff?: OpenDiff,
  git: GitRunner = defaultGitRunner,
): Promise<ReviewOutcome> {
  // Review has no `{kind:'blocked'}` path yet (Task 6): a git probe failure that
  // `selectReviewTargets` now reports as `{kind:'unavailable', ...}` rather than
  // throwing is re-thrown here, verbatim, so the ticket parks exactly as it did
  // before this task — at `review`, uncaught, escaping to the host's generic
  // log. Task 6 replaces this throw with a real `parkGateStage` park.
  const selection = opts.manifest
    ? await selectReviewTargets(opts.manifest, listWorktreesByTicket(store, opts.ticketId), git)
    : { kind: 'targets' as const, targets: [{ repo: opts.cwd, path: opts.cwd, baseRef: null, names: [] }] };
  if (selection.kind === 'unavailable') {
    throw new Error(selection.reason);
  }
  const targets = selection.targets;
  const targetRuns: { label: string; gates: GateResult[] }[] = [];
  // Tracked so the transition below can record whether the changes surface
  // genuinely opened — never assumed from "the loop ran", since only a real
  // `openDiff` (not the absence of one) actually shows the human anything.
  let diffOpened = false;
  for (const target of targets) {
    targetRuns.push({
      label: target.names.join(', ') || target.repo,
      gates: await runner(target.path),
    });
    // Surfacing the changes is useful for exactly the same affected target
    // set.
    if (openDiff) {
      openDiff(opts.ticketId, target.path);
      diffOpened = true;
    }
  }

  // Evidence remains one row per gate name. When several affected repositories
  // answer the same gate, any failure fails that gate and their outputs are
  // grouped in its artifact section. The name set is REVIEW_GATES plus
  // whatever else a target reported (e.g. `makeGateRunner`'s `package.json`
  // row for a malformed manifest) — a fixed REVIEW_GATES-only list would
  // silently drop that row from evidence and the verdict alike.
  const gateNames = [
    ...REVIEW_GATES.map(({ name }) => name),
    ...new Set(targetRuns.flatMap((run) => run.gates.map((gate) => gate.name))),
  ].filter((name, index, names) => names.indexOf(name) === index);
  const gates = gateNames.flatMap((name) => {
    const answers = targetRuns.flatMap((run) =>
      run.gates
        .filter((gate) => gate.name === name)
        .map((gate) => ({ label: run.label, gate })),
    );
    if (answers.length === 0) return [];
    const ran = answers.filter(({ gate }) => gate.exitCode !== null);
    const failure = ran.find(({ gate }) => gate.exitCode !== 0);
    return [{
      name,
      exitCode: failure?.gate.exitCode ?? (ran.length > 0 ? 0 : null),
      output: answers.map(({ label, gate }) => `## ${label}\n${gate.output}`).join('\n\n'),
      startedAt: ran.map(({ gate }) => gate.startedAt).find((value) => value !== undefined),
      endedAt: [...ran].reverse().map(({ gate }) => gate.endedAt).find((value) => value !== undefined),
    }];
  });

  // G1/G3(c): a run that asked nothing — no target resolved at all, or every
  // gate every target reported came back `null` — must never reach a verdict.
  // A green here would mean "ship it" about code review never looked at.
  // Checked before any side effect (artifact file, gate evidence, attempt)
  // so a run that asked nothing leaves none behind. Task 6 turns this throw
  // into `{kind:'blocked', blocker:'nothing-to-run', reason}`.
  if (gates.every((g) => g.exitCode === null)) {
    throw new ReviewAskedNothingError(
      opts.ticketId,
      gates.length === 0
        ? 'no target resolved — nothing changed and no relation is affected'
        : 'every gate was skipped',
    );
  }

  mkdirSync(opts.artifactDir, { recursive: true });
  const artifactPath = join(opts.artifactDir, `review-ticket-${opts.ticketId}.log`);
  const report = gates
    .map((g) => `# ${g.name} (${g.exitCode === null ? 'skipped' : `exit ${g.exitCode}`})\n${g.output}`)
    .join('\n\n');
  writeFileSync(artifactPath, report);

  // Deterministic verdict: passed iff every gate that RAN exits 0. A skipped gate
  // (null) is not a pass and not a failure — the repo never answered it.
  const failing = gates.filter((g) => g.exitCode !== null && g.exitCode !== 0);
  const verdict: Exclude<Verdict, null> =
    failing.length === 0
      ? { kind: 'passed' }
      : { kind: 'failed', reason: `gates failed: ${failing.map((g) => g.name).join(', ')}` };

  // Artifact write and gate evidence folded into the transition transaction —
  // atomic with the verdict, so a verdict never lands without the gates that
  // produced it.
  const runAt = nowIso();
  transition(store, opts.ticketId, 'review', verdict, () => {
    setStage(store, opts.ticketId, 'review', { artifactPath });
    // Read inside the transaction, before the machine bumps it on a failure:
    // these gates belong to the attempt that RAN, not to the one its failure
    // creates.
    const attempt = stageAttempt(store, opts.ticketId, 'review');
    recordGateRun(store, {
      ticketId: opts.ticketId,
      stageKey: 'review',
      attempt,
      runAt,
      gates: gates.map((g) => ({
        gateName: g.name,
        exitCode: g.exitCode,
        startedAt: g.startedAt ?? null,
        endedAt: g.endedAt ?? null,
      })),
    });
    // The changes surface is evidence exactly like a gate, recorded ONLY when
    // a real `openDiff` actually ran — a separate batch call, deliberately
    // never folded into `gates` above, so it can never touch REVIEW_GATES'
    // verdict math or artifact report (that stays the deterministic-gate
    // computation it always was). This is what lets `reviewInside` read "did
    // the changes surface open" back out of the store after a reload,
    // instead of a live `ReviewOutcome` boolean that a reload would lose.
    // Named 'changes', not 'diff': the host implementation reveals the
    // Changes panel, it does not itself open a diff editor (that only
    // happens once a human clicks a file row inside it) — the evidence must
    // say exactly what ran, not the stronger claim its old name implied.
    if (diffOpened) {
      recordGateRun(store, {
        ticketId: opts.ticketId,
        stageKey: 'review',
        attempt,
        runAt,
        gates: [{ gateName: 'changes', exitCode: 0 }],
      });
    }
  });

  return { verdict, artifactPath, gates };
}
