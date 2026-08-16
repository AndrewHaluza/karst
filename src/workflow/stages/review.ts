import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { StageRunResult } from '../../model/types.js';
import type { Manifest } from '../../manifest/types.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { HeadlessOutputChunk } from '../../agent/headlessSpawn.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import { listGateRuns, type GateRunInput } from '../../store/gateRuns.js';
import { finishProcessRun } from '../../store/processRuns.js';
import { commitGateOutcome, type RunOutcome, type RecoveryTriggerInput } from '../gates/commit.js';
import { openGateRun } from '../gates/evidence.js';
import { nowIso } from '../../model/time.js';
import { summarizeGateFailure } from '../../model/gateSummary.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { runGateList } from '../gates/runList.js';
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
 * only that the review surface did — the persisted
 * 'changes' evidence describes it that way, deliberately.
 * The host's wiring is not enough — `runReview` additionally requires
 * `review.openChanges` (default OFF); without it the function is never called
 * and no 'changes' evidence is recorded.
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
   * Called after each gate finishes, with the gate's name and its recorded
   * outcome (`null` = the repo could not answer — the note, never a verdict).
   * Lets callers push dashboard progress during long-running gate sets.
   */
  onGateComplete?: (gateName: string, exitCode: number | null) => void;
  /** Called before each gate's work begins, with the gate's name. */
  onGateStart?: (gateName: string) => void;
  /**
   * Live-output hook for the findings lane's headless calls (Task 13):
   * forwarded verbatim into `planAndRunFindingsLane`. RAW untrusted CLI prose —
   * the host that surfaces it must bound and sanitize it. Absent → no live chunks.
   */
  onFindingsOutput?: (chunk: HeadlessOutputChunk) => void;
  /**
   * Per-target findings-lane progress (Task 13 mirror): forwarded verbatim into
   * `planAndRunFindingsLane` so the host can push the same inside-progress
   * overlay the gates use. Absent → no events.
   */
  onFindingsTargetProgress?: (event: {
    repo: string;
    status: 'active' | 'completed';
    detail?: string;
  }) => void;
  /**
   * Verbose decision-point logging (§ debug logging), prefixed `[gate]`.
   * Absent → no debug lines; the host binds it to `Logger.debug` (a no-op
   * unless the manifest's `debug` flag is on).
   */
  debug?: (message: string) => void;
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
   * (`validated`/`blocking`/`execution-failed`/`interrupted`). NULL means the
   * configured process is DISABLED (Finding 2) — the same as absent: the lane
   * falls back to the plain findings adapter and opens no process run.
   */
  reviewProcess?: {
    assignment: ProcessAssignmentSnapshot;
    adapter: AgentAdapter;
  } | null;
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
   * The findings lane's process run (Task 8), captured the moment the lane
   * returns and threaded into the trigger below — a blocking-findings round
   * names the ACTUAL findings process run as its source. Deterministic gate
   * failures carry no AI process and stay null.
   */
  let findingsProcessRunId: number | null = null;

  /**
   * The recovery trigger for this run's outcome (v30), constructed HERE while
   * the failing evidence, the current stage run and the manifest cap are all
   * still in hand — never reconstructed later from `stages.verdict` or the
   * live manifest. The causal source is read off the aggregate's own failure
   * constant: a blocking-findings verdict (`FINDINGS_FAILURE_PREFIX`) is the
   * findings lane's failure and is attributed to the `review` process (its own
   * run id); every other failed verdict is a deterministic gate outcome
   * attributed to `gates`. Blocks, stops and passes carry no trigger.
   */
  const recoveryTriggerFor = (outcome: RunOutcome): RecoveryTriggerInput | null => {
    if (outcome.kind !== 'verdict' || outcome.verdict.kind !== 'failed') return null;
    const triggerDetail = outcome.verdict.reason ?? 'review gates failed';
    const fromFindings = triggerDetail.startsWith(FINDINGS_FAILURE_PREFIX);
    return {
      sourceProcessId: fromFindings ? 'review' : 'gates',
      sourceStageRunId: evidence.runId,
      // The findings lane's process run, when this failure IS the findings
      // lane's; a deterministic gate failure has no AI process. Never an id of
      // another table forced into this column.
      sourceProcessRunId: fromFindings ? findingsProcessRunId : null,
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
        // v46: a bounded excerpt of what the failing gate printed — the data a
        // fix session (or `karst context`) reads back instead of the log.
        summary:
          entry.result.exitCode !== null && entry.result.exitCode !== 0
            ? summarizeGateFailure(entry.result.output)
            : null,
      })),
    );
  };

  const planned = opts.manifest
    ? await planTargets(opts.manifest, worktrees, git)
    : {
        kind: 'targets' as const,
        targets: [{ repo: opts.cwd, path: opts.cwd, names: [] }],
        unmapped: [],
      };

  // R2 at the selection seam: karst could not even determine which repositories
  // are affected (an unreachable remote, a broken git). Never a verdict about
  // the ticket's code, so this parks rather than transitioning or throwing.
  if (planned.kind === 'unavailable') {
    opts.debug?.(
      `[gate] review ticket ${opts.ticketId}: targets unavailable (${planned.blocker}: ${planned.reason})`,
    );
    return finish({ kind: 'blocked', blocker: planned.blocker, reason: planned.reason }, [
      planned.reason,
    ]);
  }
  const targets: ReviewGateTarget[] = planned.targets;
  opts.debug?.(
    `[gate] review ticket ${opts.ticketId}: planned ${targets.length} target(s) ` +
      `(manifest ${opts.manifest ? 'present' : 'absent'}, ${worktrees.length} worktree(s) registered)`,
  );

  // R1 — no target resolved. THREE situations that must not read as one, in
  // the order they are ruled out below.
  if (targets.length === 0) {
    // Zero worktrees is not "nothing changed": nothing was ASKED. The ticket
    // has no repository to run review against at all, and passing here would
    // walk a stage that ran nothing straight to ship — the vacuous green the
    // "asked nothing is never green" invariant exists to prevent. Resumable:
    // registering a worktree (re-scoping) makes a retry succeed.
    if (worktrees.length === 0) {
      const reason =
        'no worktree is registered for this ticket, so there is no repository to run review against';
      opts.debug?.(`[gate] review ticket ${opts.ticketId}: zero targets — no worktree registered`);
      return finish({ kind: 'blocked', blocker: 'nothing-to-run', reason }, [reason]);
    }
    // A worktree that matched no manifest entry: karst could not ask that
    // repository anything, and only a human editing karst.yml (or re-scoping
    // the ticket) can change the answer — that parks. Below it, every worktree
    // mapped and none has changes: review asked and the answer is "nothing to
    // check", a deliverable the stage already has, so it passes with a note
    // rather than parking forever.
    if (planned.unmapped.length > 0) {
      const reason =
        `these worktrees match no repository in karst.yml: ${planned.unmapped.join(', ')} — ` +
        'add them to `repositories:` or re-scope the ticket';
      opts.debug?.(
        `[gate] review ticket ${opts.ticketId}: zero targets — ${planned.unmapped.length} worktree(s) unmapped`,
      );
      return finish({ kind: 'blocked', blocker: 'unmapped-repository', reason }, [reason]);
    }
    const note = 'no repository has changes from its base, so review had nothing to check';
    opts.debug?.(`[gate] review ticket ${opts.ticketId}: zero targets — nothing changed from base`);
    return finish({ kind: 'verdict', verdict: { kind: 'passed' } }, [note]);
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
        opts.debug?.(
          `[gate] review ticket ${opts.ticketId}: target ${label} has nothing to run ` +
            `(${resolution.reason})`,
        );
        sections.push(`# ${label} (nothing to run)\n${resolution.reason}`);
        continue;
      }

      // R2, which IS per target: karst could not READ this repository. That is
      // environmental, a human has to act on it, and no other target's green
      // answers it — so it parks, and the completed targets' rows go down with
      // the park.
      const reason = `${label}: ${resolution.reason}`;
      opts.debug?.(
        `[gate] review ticket ${opts.ticketId}: target ${label} unreadable ` +
          `(${resolution.blocker}: ${resolution.reason})`,
      );
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
    opts.debug?.(
      `[gate] review ticket ${opts.ticketId}: target ${label} — ${resolution.gates.length} gate(s)` +
        (resolution.skipped.length > 0 ? `, ${resolution.skipped.length} disabled` : ''),
    );
    const run = await runGates(resolution.gates, target.path, {
      signal: opts.signal,
      now,
      scriptsAvailable: (script) => scripts[script] !== undefined,
      onGateStart: opts.onGateStart,
      onDebug: opts.debug,
      // Each gate row is appended the INSTANT that gate finishes — inside the
      // runner's own loop, before the next gate starts, so a host death between
      // two gates still leaves every finished gate readable (process death
      // fires no abort signal, so the `stopped` path never runs). Zipped by
      // POSITION like the aggregation below: two manifest entries sharing a
      // worktree can declare the same gate name, so a name lookup would attach
      // the wrong identity to the row.
      onGateComplete: (name, exitCode, startedAt, endedAt, index, output) => {
        const gate = resolution.gates[index];
        evidence.append([{
          gateName: `${name} (${label})`,
          exitCode,
          startedAt,
          endedAt,
          repo: target.repo,
          command: gate?.command ?? name,
          args: gate?.args ?? [],
          // v46: captured HERE, at the same instant the row lands, so the
          // failure summary is evidence a later session can read without
          // opening the artifact log.
          summary:
            exitCode !== null && exitCode !== 0 ? summarizeGateFailure(output ?? '') : null,
        }]);
        opts.onGateComplete?.(name, exitCode);
      },
    });

    const produced: AggregateEntry[] = [];
    for (const [index, result] of run.results.entries()) {
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

    // A Stop yields no verdict and no attempt. What already finished is still
    // recorded — discarding it would make work that really happened
    // unrecoverable — but nothing further is opened in the user's face.
    if (run.kind === 'stopped') {
      return finish({ kind: 'stopped' }, ['stopped before every gate finished']);
    }

    // The changes are worth seeing whatever the gates said, so this runs before
    // any verdict exists — for exactly the affected target set — but ONLY when
    // `review.openChanges` says so: the host always wires `openDiff`, so absent
    // the setting nothing opens (the toggle, default OFF, is the user's control
    // over whether review reveals the Changes panel at all).
    if (deps.openDiff && opts.manifest?.review?.openChanges) {
      deps.openDiff(opts.ticketId, target.path);
      // The changes surface is evidence exactly like a gate, recorded ONLY when
      // a real `openDiff` ran — and kept out of `entries` so it can never touch
      // the verdict, which stays the deterministic-gate computation it always
      // was. This is what persists "did the changes surface open" as evidence
      // that can be read back out of the store after a reload. Written once, on the first
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
  // `worktrees.branch` per repository path, so the scope block can name the
  // ticket's branch: the diff range then resolves `origin/<base>...<branch>`
  // BY NAME, which reads the same from any checkout — a worktree sitting on
  // the base branch no longer reads as "no changes" (fu1).
  const branchByRepo = new Map(worktrees.map((w) => [w.repo, w.branch]));

  // Resolves the config default, and (spec §8.14) skips the AI call entirely
  // when R3/R4/R5 already decided the run — see `planAndRunFindingsLane`.
  const { outcome: findingsLane, blockingSeverity } = await planAndRunFindingsLane({
    entries,
    targets: targets.map((t) => ({
      repo: t.repo,
      worktreePath: t.path,
      baseRef: baseRefByRepo.get(t.repo) ?? null,
      branch: branchByRepo.get(t.repo) ?? null,
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
    // The lane's own decision points (which target was asked, what came back,
    // a rejected call, the outcome) ride the stage's debug stream.
    debug: opts.debug,
    // Task 13: live output + per-target progress from the findings lane's
    // headless calls, forwarded to the host's console/overlay surfaces.
    onOutput: opts.onFindingsOutput,
    onTargetProgress: opts.onFindingsTargetProgress,
    // F2 — persisted the INSTANT each target's call returns, inside the lane,
    // before any aggregation rule reads them. These are completed model output
    // the user has already paid for (a single lane has cost 1.3M tokens), and
    // holding them until the lane — let alone the verdict — ended was what let
    // a host restart discard a whole run with nothing recorded anywhere.
    persistFindings: (findings, processRunId) =>
      evidence.appendFindings(findings, processRunId),
  });
  // Captured here — before the verdict exists — so the trigger below names the
  // exact process run that produced a blocking verdict, when it is the lane's.
  findingsProcessRunId =
    findingsLane.kind === 'ran' ? (findingsLane.processRunId ?? null) : null;

  // Finding 3: a Stop during the findings lane is not a review of anything —
  // the open Review process is closed interrupted, and the run returns stopped
  // BEFORE `aggregateReview` (a stopped lane is not evidence) and before any
  // recovery trigger construction. Beyond the gate rows that already finished,
  // only the TARGETS' findings that already returned are on disk — the stopped
  // target's call is never parsed, so its output is never treated as evidence.
  if (findingsLane.kind === 'stopped') {
    const stoppedRunId = findingsLane.processRunId ?? null;
    if (stoppedRunId !== null) {
      finishProcessRun(store, stoppedRunId, 'interrupted', now(), 'interrupted');
    }
    return finish({ kind: 'stopped' }, ['review stopped before the findings lane finished']);
  }

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
  opts.debug?.(
    `[gate] review ticket ${opts.ticketId}: aggregate over ${entries.length} entry(ies)` +
      `${skippedNames.length > 0 ? `, ${skippedNames.length} skipped` : ''}` +
      `, findings lane ${findingsLane.kind}` +
      ` → ${
        outcome.kind === 'blocked'
          ? `blocked (${outcome.blocker}: ${outcome.reason})`
          : `verdict ${outcome.verdict.kind}${
              outcome.verdict.kind === 'failed' && outcome.verdict.reason
                ? ` (${outcome.verdict.reason})`
                : ''
            }`
      }`,
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
