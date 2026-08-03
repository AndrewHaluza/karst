import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { StageRunResult } from '../../model/types.js';
import type { Manifest } from '../../manifest/types.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import { listGateRuns, type GateRunInput } from '../../store/gateRuns.js';
import type { FindingInput } from '../../store/reviewFindings.js';
import { commitGateOutcome, type RunOutcome } from '../gates/commit.js';
import { nowIso } from '../../model/time.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { runGateList } from '../gates/runList.js';
import { noTargetsReason } from '../gates/targets.js';
import { planReviewTargets, type ReviewGateTarget } from '../review/targets.js';
import { resolveReviewGates } from '../review/gates.js';
import {
  aggregateReview,
  malformedPackageJsonEntry,
  uatIdentitiesFrom,
  DEFAULT_REQUIRE_INDEPENDENT_SIGNAL,
  type AggregateEntry,
} from '../review/aggregate.js';
import { planAndRunFindingsLane } from '../review/findingsLane.js';
import type { WarnFn } from '../review/findings.js';

/**
 * Review stage — orchestration only.
 *
 * Plan the affected repositories, resolve each one's review gates from a
 * package.json probe, run them, surface the changes for a human, and reduce.
 * The verdict conjunction lives in `review/aggregate.ts` (§6.4 R1–R9) and the
 * gate mechanics in `gates/resolve.ts`/`gates/runList.ts` — this file states no
 * rule of its own.
 *
 * Returns `StageRunResult`: a run that could not ask its question parks durably
 * (`parkGateStage`) rather than transitioning or throwing, and consumes no
 * attempt — nothing about the code was learned. A run the user stopped keeps
 * whatever already finished and consumes no attempt either.
 */

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
  /** The ticket's primary worktree; used only when no manifest is supplied. */
  cwd: string;
  artifactDir: string;
  /**
   * When present, review is repository-aware: only directly changed worktrees
   * and worktrees affected through dependsOn relations are checked.
   */
  manifest?: Manifest;
  /** One signal for the whole run, so a Stop reaches the gate in flight. */
  signal?: AbortSignal;
}

export interface ReviewDeps {
  planTargets?: typeof planReviewTargets;
  probe?: (cwd: string) => ScriptProbe;
  runGates?: typeof runGateList;
  git?: GitRunner;
  now?: () => string;
  /**
   * Absent means nothing opens, and the evidence below says so — a default that
   * quietly "succeeds" is exactly the lie this closes.
   */
  openDiff?: OpenDiff;
  /**
   * The agent core the findings lane (Lane B) asks about the diff. Absent
   * means no agent core is available — `capability-missing` (spec §8.14) when
   * `review.findings.enabled` and the gates haven't already decided the
   * outcome, never a failure: an agent that cannot be asked is environmental.
   */
  findingsAdapter?: AgentAdapter;
  /**
   * Where the findings lane's boundary diagnostics land (a failed AI call,
   * an unparseable response, an untrustworthy `file`) — threaded through to
   * `planAndRunFindingsLane`/`parseFindings`. Absent falls all the way back
   * to `parseFindings`'s own `console.warn` default; the host always supplies
   * one bound to `Logger.warn` so these reach karst's output channel instead.
   */
  warn?: WarnFn;
}

export async function runReview(
  store: Store,
  opts: RunReviewOpts,
  deps: ReviewDeps = {},
): Promise<StageRunResult> {
  const now = deps.now ?? nowIso;
  const planTargets = deps.planTargets ?? planReviewTargets;
  const probe = deps.probe ?? probeScripts;
  const runGates = deps.runGates ?? runGateList;
  const git = deps.git ?? defaultGitRunner;
  const runAt = now();

  const worktrees = opts.manifest ? listWorktreesByTicket(store, opts.ticketId) : [];

  const entries: AggregateEntry[] = [];
  const sections: string[] = [];
  // Tracked so the outcome below can record whether the changes surface
  // genuinely opened — never assumed from "the loop ran", since only a real
  // `openDiff` (not the absence of one) actually shows the human anything.
  let diffOpened = false;

  /**
   * Write the log and commit the outcome with everything collected so far.
   * `findings` defaults to empty — every early-return path (R1/R2, malformed
   * probes, a stopped run) never reached the lane, so there is nothing to
   * record; only the final call after `runFindingsLane` passes any.
   */
  const finish = (
    outcome: RunOutcome,
    notes: readonly string[] = [],
    findings: readonly FindingInput[] = [],
  ): StageRunResult => {
    mkdirSync(opts.artifactDir, { recursive: true });
    const artifactPath = join(opts.artifactDir, `review-ticket-${opts.ticketId}.log`);
    writeFileSync(artifactPath, [...notes.map((note) => `! ${note}`), ...sections].join('\n\n'));
    const gates = entries.map<GateRunInput>((entry) => ({
      gateName: entry.result.name,
      exitCode: entry.result.exitCode,
      startedAt: entry.result.startedAt ?? null,
      endedAt: entry.result.endedAt ?? null,
      // v21 invocation identity — recorded here too so a LATER review run (or a
      // future rule) can compare against what THIS run actually invoked.
      repo: entry.identity.repo,
      command: entry.identity.command,
      args: entry.identity.args,
    }));
    // The changes surface is evidence exactly like a gate, recorded ONLY when a
    // real `openDiff` ran — appended here rather than folded into `entries` so
    // it can never touch the verdict, which stays the deterministic-gate
    // computation it always was. This is what lets `reviewInside` read "did the
    // changes surface open" back out of the store after a reload.
    if (diffOpened) gates.push({ gateName: 'changes', exitCode: 0 });
    return commitGateOutcome(store, {
      ticketId: opts.ticketId,
      stageKey: 'review',
      runAt,
      artifactPath,
      gates,
      outcome,
      findings,
    });
  };

  const planned = opts.manifest
    ? await planTargets(opts.manifest, worktrees, git)
    : { kind: 'targets' as const, targets: [{ repo: opts.cwd, path: opts.cwd, names: [] }] };

  // R2 at the selection seam: karst could not even determine which repositories
  // are affected (an unreachable remote, a broken git). Never a verdict about
  // the ticket's code, so this parks rather than transitioning or throwing.
  if (planned.kind === 'unavailable') {
    return finish({ kind: 'blocked', blocker: planned.blocker, reason: planned.reason }, [
      planned.reason,
    ]);
  }
  const targets: ReviewGateTarget[] = planned.targets;

  // R1 — no target resolved. A ticket at review with nothing changed is an
  // anomaly (impl produced nothing, or the worktrees are unmapped) and must
  // reach a human, not ship.
  if (targets.length === 0) {
    const reason = noTargetsReason(worktrees, 'review');
    return finish({ kind: 'blocked', blocker: 'nothing-to-run', reason }, [reason]);
  }

  for (const target of targets) {
    const label = target.names.join(', ') || target.repo;
    const scriptProbe = probe(target.path);
    const resolution = resolveReviewGates(scriptProbe, opts.manifest?.review, target.names);

    if (resolution.kind === 'unavailable') {
      // R3 is decided ACROSS every target, so "this repository answers none of
      // review's questions" is not a park on its own — it is one target
      // contributing no entry, and `aggregateReview` parks only if NO target
      // contributed one. Returning here instead would discard the green of a
      // target already run, never probe the ones after it, make the outcome
      // depend on target order, and leave every mixed-stack ticket (a Go
      // service, a docs package, anything without a package.json — `absent`
      // resolves here too) permanently unprogressable. It is still recorded:
      // an absence a human cannot see reads the same as a repository karst
      // never met.
      if (resolution.blocker === 'nothing-to-run') {
        sections.push(`# ${label} (nothing to run)\n${resolution.reason}`);
        continue;
      }

      // R2, which IS per target: karst could not READ this repository. That is
      // environmental, a human has to act on it, and no other target's green
      // answers it — so it parks, and the completed targets' rows go down with
      // the park.
      const reason = `${label}: ${resolution.reason}`;
      return finish({ kind: 'blocked', blocker: resolution.blocker, reason }, [reason]);
    }

    // R4 — a malformed package.json resolves to zero gates and IS a failure
    // about the repository. An agent can fix it, so it must reach a verdict.
    if (resolution.gates.length === 0 && scriptProbe.kind === 'malformed') {
      entries.push(malformedPackageJsonEntry(target.repo, label, scriptProbe.message, runAt));
      sections.push(`# package.json (${label}, exit 1)\n${scriptProbe.message}`);
      continue;
    }

    const scripts = scriptProbe.kind === 'ok' ? scriptProbe.scripts : {};
    const run = await runGates(resolution.gates, target.path, {
      signal: opts.signal,
      now,
      scriptsAvailable: (script) => scripts[script] !== undefined,
    });

    for (const [index, result] of run.results.entries()) {
      // Zipped by POSITION: `runGateList` emits one result per gate in order,
      // so a name lookup could attach the wrong identity to the row.
      const gate = resolution.gates[index];
      entries.push({
        result: { ...result, name: `${result.name} (${label})` },
        identity: {
          repo: target.repo,
          command: gate?.command ?? result.name,
          args: gate?.args ?? [],
        },
      });
      sections.push(
        `# ${result.name} (${label}, ${result.exitCode === null ? 'skipped' : `exit ${result.exitCode}`})\n${result.output}`,
      );
    }

    // A Stop yields no verdict and no attempt. What already finished is still
    // recorded — discarding it would make work that really happened
    // unrecoverable — but nothing further is opened in the user's face.
    if (run.kind === 'stopped') {
      return finish({ kind: 'stopped' }, ['stopped before every gate finished']);
    }

    // The changes are worth seeing whatever the gates said, so this runs before
    // any verdict exists — for exactly the affected target set.
    if (deps.openDiff) {
      deps.openDiff(opts.ticketId, target.path);
      diffOpened = true;
    }
  }

  // `worktrees.base_ref` per repository path, so the findings prompt can name
  // the exact range it must diff against instead of asking the agent to guess.
  const baseRefByRepo = new Map(worktrees.map((w) => [w.repo, w.baseRef]));

  // Resolves the config default, and (spec §8.14) skips the AI call entirely
  // when R3/R4/R5 already decided the run — see `planAndRunFindingsLane`.
  const { outcome: findingsLane, blockingSeverity } = await planAndRunFindingsLane({
    entries,
    targets: targets.map((t) => ({
      repo: t.repo,
      worktreePath: t.path,
      baseRef: baseRefByRepo.get(t.repo) ?? null,
    })),
    findingsConfig: opts.manifest?.review?.findings,
    adapter: deps.findingsAdapter,
    ticketId: opts.ticketId,
    signal: opts.signal,
    warn: deps.warn,
  });
  const collectedFindings: readonly FindingInput[] =
    findingsLane.kind === 'ran' ? findingsLane.findings : [];

  const outcome = aggregateReview(
    entries,
    uatIdentitiesFrom(listGateRuns(store, opts.ticketId)),
    findingsLane,
    {
      // Manifest value wins; absent manifest, absent `review:` block, or an
      // absent key all fall back to the same default (`true`) — a review that
      // re-asks only UAT's questions has added no signal.
      requireIndependentSignal:
        opts.manifest?.review?.requireIndependentSignal ?? DEFAULT_REQUIRE_INDEPENDENT_SIGNAL,
      findingsBlockingSeverity: blockingSeverity,
    },
  );
  if (outcome.kind === 'blocked') {
    return finish(
      { kind: 'blocked', blocker: outcome.blocker, reason: outcome.reason },
      [outcome.reason],
      collectedFindings,
    );
  }
  return finish(
    { kind: 'verdict', verdict: outcome.verdict },
    outcome.warnings,
    collectedFindings,
  );
}
