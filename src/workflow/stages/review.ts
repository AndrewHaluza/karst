import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { StageRunResult } from '../../model/types.js';
import type { Manifest } from '../../manifest/types.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import { listGateRuns, type GateRunInput } from '../../store/gateRuns.js';
import { finishProcessRun } from '../../store/processRuns.js';
import type { FindingInput } from '../../store/reviewFindings.js';
import { commitGateOutcome, type RunOutcome, type RecoveryTriggerInput } from '../gates/commit.js';
import { openGateRun } from '../gates/evidence.js';
import { nowIso } from '../../model/time.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { runGateList } from '../gates/runList.js';
import { noTargetsReason } from '../gates/targets.js';
import { planReviewTargets, type ReviewGateTarget } from '../review/targets.js';
import { resolveReviewGates } from '../review/gates.js';
import { getDisabledGates } from '../../store/ticketGates.js';
import { capForGate } from '../fixAttempts.js';
import {
  aggregateReview,
  malformedPackageJsonEntry,
  uatIdentitiesFrom,
  DEFAULT_REQUIRE_INDEPENDENT_SIGNAL,
  FINDINGS_FAILURE_PREFIX,
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
  /**
   * Called after each gate finishes, with the gate's name. Lets callers push
   * dashboard progress during long-running gate sets.
   */
  onGateComplete?: (gateName: string) => void;
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
   * The Review findings PROCESS (Task 8): its immutable assignment snapshot
   * and the already instrumented adapter. When present, the lane opens a
   * `process_runs` row before its first call (snapshotting the assignment),
   * threads the run id through token attribution and the findings batch, and
   * the stage finishes the run with an explicit result kind
   * (`validated`/`blocking`/`execution-failed`). Absent → the lane runs with
   * `findingsAdapter` (or capability-missing) and opens no process run.
   */
  reviewProcess?: {
    assignment: ProcessAssignmentSnapshot;
    adapter: AgentAdapter;
  };
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

  // Opened BEFORE anything runs, and durable. Everything below appends to it as
  // it happens: a host restart mid-run must leave a readable record that this
  // run existed and what it had already learned, since process death fires no
  // abort signal and the `stopped` path therefore never runs.
  const evidence = openGateRun(store, {
    ticketId: opts.ticketId,
    stageKey: 'review',
    runAt,
    manifest: opts.manifest,
    pid: process.pid,
  });

  const worktrees = opts.manifest ? listWorktreesByTicket(store, opts.ticketId) : [];

  const entries: AggregateEntry[] = [];
  const sections: string[] = [];
  // Tracked so the outcome below can record whether the changes surface
  // genuinely opened — never assumed from "the loop ran", since only a real
  // `openDiff` (not the absence of one) actually shows the human anything.
  let diffOpened = false;
  // Read from the store at RESOLUTION time, never from anything cached: a
  // toggle flipped mid-session must take effect on the very next gate run,
  // which is the same live-read property `opts.manifest`'s getter gives the
  // manifest itself.
  const disabledNames = getDisabledGates(store, opts.ticketId).review;
  // The BARE gate names, kept beside the evidence rows rather than recovered
  // from them: a row's `gateName` is repo-decorated ("test (web)") because that
  // is what identifies an invocation, and the block reason already parenthesizes
  // the list — reusing it there nests the parentheses.
  const skippedNames: string[] = [];

  /**
   * The recovery trigger for this run's outcome (v30), constructed HERE while
   * the failing evidence, the current stage run and the manifest cap are all
   * still in hand — never reconstructed later from `stages.verdict` or the
   * live manifest. The causal source is read off the aggregate's own failure
   * constant: a blocking-findings verdict (`FINDINGS_FAILURE_PREFIX`) is the
   * findings lane's failure and is attributed to the `review` process; every
   * other failed verdict is a deterministic gate outcome attributed to
   * `gates`. Blocks, stops and passes carry no trigger.
   */
  const recoveryTriggerFor = (outcome: RunOutcome): RecoveryTriggerInput | null => {
    if (outcome.kind !== 'verdict' || outcome.verdict.kind !== 'failed') return null;
    const triggerDetail = outcome.verdict.reason ?? 'review gates failed';
    const fromFindings = triggerDetail.startsWith(FINDINGS_FAILURE_PREFIX);
    return {
      sourceProcessId: fromFindings ? 'review' : 'gates',
      sourceStageRunId: evidence.runId,
      // The findings lane's process run, when the caller captured one; a
      // deterministic gate failure has no AI process. Never an id of another
      // table forced into this column.
      sourceProcessRunId: null,
      triggerKind: fromFindings ? 'blocking-review-findings' : 'gate-failure',
      triggerDetail,
      maxRounds: capForGate('review', opts.manifest?.uat?.maxFixAttempts, opts.manifest?.review?.maxFixAttempts),
    };
  };

  /**
   * Write the log and commit the outcome.
   *
   * Carries NO gate rows: every one of them was appended the moment it was
   * produced (`evidence.append`), so by here the store already holds this run's
   * whole evidence and there is nothing left to hand over but the outcome — and
   * the run id that closes the open `stage_runs` row.
   */
  const finish = (outcome: RunOutcome, notes: readonly string[] = []): StageRunResult => {
    mkdirSync(opts.artifactDir, { recursive: true });
    const artifactPath = join(opts.artifactDir, `review-ticket-${opts.ticketId}.log`);
    writeFileSync(artifactPath, [...notes.map((note) => `! ${note}`), ...sections].join('\n\n'));
    return commitGateOutcome(store, {
      ticketId: opts.ticketId,
      stageKey: 'review',
      runAt,
      artifactPath,
      gates: [],
      outcome,
      stageRunId: evidence.runId,
      recoveryTrigger: recoveryTriggerFor(outcome) ?? undefined,
      now,
    });
  };

  /** Append one target's gate rows the instant that target finishes running them. */
  const recordEntries = (rows: readonly AggregateEntry[]): void => {
    evidence.append(
      rows.map<GateRunInput>((entry) => ({
        gateName: entry.result.name,
        exitCode: entry.result.exitCode,
        startedAt: entry.result.startedAt ?? null,
        endedAt: entry.result.endedAt ?? null,
        // v21 invocation identity — recorded here too so a LATER review run (or a
        // future rule) can compare against what THIS run actually invoked.
        repo: entry.identity.repo,
        command: entry.identity.command,
        args: entry.identity.args,
      })),
    );
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
    const resolution = resolveReviewGates(
      scriptProbe,
      opts.manifest?.review,
      target.names,
      disabledNames,
    );

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

    // One row per gate the user switched off, carrying the identity it WOULD
    // have been invoked with. No timing and no exit code, because none exists —
    // `skipped` is what states the difference from a missing script.
    for (const gate of resolution.skipped) {
      const skippedRow: GateRunInput = {
        gateName: `${gate.name} (${label})`,
        exitCode: null,
        startedAt: null,
        endedAt: null,
        repo: target.repo,
        command: gate.command,
        args: gate.args,
        skipped: true,
      };
      // Kept OUT of `entries`: a skipped gate must not reach `aggregateReview`
      // as an entry, where an exit-code-null row reads as "the repo has no such
      // script". It is evidence, not a question that was asked.
      evidence.append([skippedRow]);
      skippedNames.push(gate.name);
      sections.push(`# ${gate.name} (${label}, skipped)\ndisabled for this ticket`);
    }

    // R4 — a malformed package.json resolves to zero gates and IS a failure
    // about the repository. An agent can fix it, so it must reach a verdict.
    if (resolution.gates.length === 0 && scriptProbe.kind === 'malformed') {
      const malformed = malformedPackageJsonEntry(target.repo, label, scriptProbe.message, runAt);
      entries.push(malformed);
      recordEntries([malformed]);
      sections.push(`# package.json (${label}, exit 1)\n${scriptProbe.message}`);
      continue;
    }

    const scripts = scriptProbe.kind === 'ok' ? scriptProbe.scripts : {};
    const run = await runGates(resolution.gates, target.path, {
      signal: opts.signal,
      now,
      scriptsAvailable: (script) => scripts[script] !== undefined,
      onGateComplete: opts.onGateComplete,
    });

    const produced: AggregateEntry[] = [];
    for (const [index, result] of run.results.entries()) {
      // Zipped by POSITION: `runGateList` emits one result per gate in order,
      // so a name lookup could attach the wrong identity to the row.
      const gate = resolution.gates[index];
      produced.push({
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
    entries.push(...produced);
    recordEntries(produced);

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
      // The changes surface is evidence exactly like a gate, recorded ONLY when
      // a real `openDiff` ran — and kept out of `entries` so it can never touch
      // the verdict, which stays the deterministic-gate computation it always
      // was. This is what lets `reviewInside` read "did the changes surface
      // open" back out of the store after a reload. Written once, on the first
      // target that opened one: it is one fact about the run, not one per repo.
      if (!diffOpened) evidence.append([{ gateName: 'changes', exitCode: 0 }]);
      diffOpened = true;
    }
  }

  // The Review AI process (Task 8) carries its own adapter; absent, the lane
  // falls back to the plain findings adapter (or capability-missing).
  const reviewProcess = deps.reviewProcess;
  const findingsAdapter = reviewProcess?.adapter ?? deps.findingsAdapter;

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
    adapter: findingsAdapter,
    ticketId: opts.ticketId,
    signal: opts.signal,
    warn: deps.warn,
    // Task 8: open the Review process run before the lane's first call,
    // snapshotting the resolved assignment identity.
    store,
    process: reviewProcess
      ? {
          assignment: reviewProcess.assignment,
          adapter: reviewProcess.adapter,
          stageRunId: evidence.runId,
          attempt: evidence.attempt,
          pid: process.pid,
          startedAt: runAt,
        }
      : undefined,
  });
  // F2 — persisted the INSTANT the lane returns, before a single aggregation
  // rule reads them. These are completed model output the user has already paid
  // for (a single lane has cost 1.3M tokens), and holding them until the verdict
  // is what let a host restart discard them with nothing recorded anywhere.
  const collectedFindings: readonly FindingInput[] =
    findingsLane.kind === 'ran' ? findingsLane.findings : [];
  evidence.appendFindings(
    collectedFindings,
    findingsLane.kind === 'ran' ? findingsLane.processRunId ?? null : null,
  );

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
      disabledGateNames: skippedNames,
    },
  );

  // Task 8: close the Review findings process run with its EXPLICIT result
  // kind — the AI call's crash is recorded as `execution-failed` (never a code
  // verdict, never a recovery round), blocking findings as `blocking`, and a
  // clean lane as `validated`. The artifact path rides along so the inside
  // view can expose the run's log.
  const crashes: readonly string[] =
    findingsLane.kind === 'ran' ? (findingsLane.crashes ?? []) : [];
  const processRunId =
    findingsLane.kind === 'ran' ? (findingsLane.processRunId ?? null) : null;
  if (processRunId !== null) {
    const blocking =
      outcome.kind === 'verdict' &&
      outcome.verdict.kind === 'failed' &&
      (outcome.verdict.reason ?? '').startsWith(FINDINGS_FAILURE_PREFIX);
    const artifactPath = join(opts.artifactDir, `review-ticket-${opts.ticketId}.log`);
    if (crashes.length > 0) {
      finishProcessRun(store, processRunId, 'failed', now(), 'execution-failed', artifactPath);
    } else if (blocking) {
      finishProcessRun(store, processRunId, 'failed', now(), 'blocking', artifactPath);
    } else {
      finishProcessRun(store, processRunId, 'passed', now(), 'validated', artifactPath);
    }
  }
  // The crash diagnostics land in the artifact too — a failed lane must be
  // distinguishable from a clean review in the log, not just in a log line.
  const crashNotes = crashes.map((c) => `review findings lane failed: ${c}`);

  if (outcome.kind === 'blocked') {
    return finish({ kind: 'blocked', blocker: outcome.blocker, reason: outcome.reason }, [
      outcome.reason,
      ...crashNotes,
    ]);
  }
  return finish({ kind: 'verdict', verdict: outcome.verdict }, [
    ...outcome.warnings,
    ...crashNotes,
  ]);
}
