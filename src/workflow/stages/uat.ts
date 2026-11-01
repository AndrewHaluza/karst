import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { StageRunResult } from '../../model/types.js';
import type { Manifest, UatConfig } from '../../manifest/types.js';
import { UAT_TESTER_ON_SKIP } from '../../manifest/qualityDefaults.js';
import { runnableSubset, unitsOf, unitsOfRepos } from '../../manifest/runnable.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { HeadlessOutputChunk } from '../../agent/headlessSpawn.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import type { GateRunInput } from '../../store/gateRuns.js';
import { commitGateOutcome, type RunOutcome, type RecoveryTriggerInput } from '../gates/commit.js';
import { openGateRun } from '../gates/evidence.js';
import { escalatedRefusalReason, hostRefusalRepeats } from '../gates/hostRefusalRepeat.js';
import { nowIso } from '../../model/time.js';
import { summarizeGateFailure } from '../../model/gateSummary.js';
import {
  listServersByTicket,
  listWorktreesByTicket,
  type ServerView,
} from '../../store/dashboard.js';
import { listGateRuns, type GateRun } from '../../store/gateRuns.js';
import { listProcessRuns, setProcessRunResultKind } from '../../store/processRuns.js';
import { baseDefinesScript } from '../gates/npmScript.js';
import { resolveTicketBaseRef } from '../baseRef.js';
import { cutGatesWithoutUiChange } from '../gates/uiDiff.js';
import { NO_UI_CHANGE_REASON } from '../gates/uiScope.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { resolveGates, type GateResolution, type ResolvedGate } from '../gates/resolve.js';
import { applyConfigSwitch, partitionDisabled, type StageGateResolution } from '../gates/disable.js';
import { runGateList } from '../gates/runList.js';
import { regenerateOption } from '../gates/regenerateOption.js';
import type { GateOutputChunk } from '../gates/run.js';
import { checkNodeDeps, type NodeDepsCheck } from '../gates/depsCheck.js';
import { usageLimitReason } from '../../agent/cliFailure.js';
import { declaredCheckGates } from '../review/declaredGates.js';
import { planUatTargets, type UatTarget } from '../uat/targets.js';
import { declaredGatesFor, PROBE_SCRIPTS } from '../uat/gates.js';
import {
  runUatTester,
  type TesterRunningService,
  type TesterTarget,
  type TesterRunResult,
} from '../uat/tester.js';
import {
  runTesterVerifier,
  TESTER_VERIFIER_FAILURE_PREFIX,
  TESTER_OBSERVATIONS_FAILURE_PREFIX,
  type TesterGateRunner,
} from '../uat/testerVerifier.js';
import type { WarnFn } from '../review/findings.js';
import { getDisabledGates, getHostGates } from '../../store/ticketGates.js';
import { withHostOverride } from '../gates/resourceKill.js';
import { capForGate } from '../fixAttempts.js';
import { getTicket } from '../../store/tickets.js';
import { raiseDevelopRedAlert } from '../../store/developRed.js';
import { latestBaselineDecisions } from '../../store/baselineDecisions.js';
import { unapprovedBaselines } from '../gates/baselineReview.js';
import { detectTicketBaselines, fingerprintTicket } from '../gates/baselineReviewTicket.js';
import { hasUatGatePass, recordUatGatePass } from '../../store/uatGatePasses.js';
import { stageAttempt } from '../../store/stages.js';
import {
  aggregateUat,
  reviewIdentitiesFrom,
  type AggregateEntry,
  type GateIdentity,
} from '../uat/aggregate.js';
import { SpinCancelledError, type SpinResult } from '../../runtime/spin.js';
import { gateEntriesFrom } from '../review/aggregate.js';
import { targetTree, unresolvedTargets, manifestNamesFor } from '../rerunTargets.js';
import { mergeUatKeptOutcome, type UatKeptTarget } from '../uat/keptOutcome.js';
import { combinedBlocking, persistSiblingObservations } from '../uat/rerunObservations.js';
import type { UatFindingInput } from '../../store/uatFindings.js';

/**
 * UAT stage — orchestration only.
 *
 * Plan the affected repositories, resolve each one's gate list (explicit config
 * else a package.json probe), run them, and reduce. The verdict conjunction lives
 * in `uat/aggregate.ts` and the gate mechanics in `gates/resolve.ts`/`gates/runList.ts`
 * (UAT's own config shape stays in `uat/gates.ts`), because this file was 134
 * lines and would be 600–900 if every mechanism landed in it.
 *
 * Returns `StageRunResult`: a run that could not ask its question parks durably
 * (`parkGateStage`) rather than transitioning or throwing, and consumes no
 * attempt — nothing about the code was learned.
 */

/**
 * A usage-limit one-shot re-run of the parked UAT lane. With it the stage asks
 * only `targets`, runs no deterministic gate (the parked attempt's rows are the
 * aggregate's inputs, so `aggregateUat` alone still produces `bypassed` and the
 * zero-ran block), counts and persists the sibling observations the earlier
 * park kept, and runs the Tester with the picked process. Baseline review,
 * services, verifier, threshold, verdict and commit are the stage's own.
 */
export interface UatRerun {
  targets: readonly string[];
  previousGateRuns: readonly GateRun[];
  siblingObservations: readonly UatFindingInput[];
  siblingTargets: readonly UatKeptTarget[];
  tester: { assignment: ProcessAssignmentSnapshot; adapter: AgentAdapter };
}

export interface RunUatOpts {
  /** Re-run only the parked lane targets with a one-shot Tester. */
  rerun?: UatRerun;
  ticketId: number;
  /** The ticket's primary worktree; used only when no manifest is supplied. */
  cwd: string;
  artifactDir: string;
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
   * Live output from the deterministic gate lane, chunk by chunk, tagged with
   * the gate's name — the gates' counterpart of the agent lane's live hook.
   * RAW untrusted CLI prose; the host that surfaces it sanitizes it (the
   * `GateConsole` sink). Absent → no live chunks.
   */
  onGateOutput?: (gateName: string, chunk: GateOutputChunk) => void;
  /**
   * Live-output hook for the Tester's headless calls (Task 13): forwarded
   * verbatim into `runUatTester`. RAW untrusted CLI prose — the host that
   * surfaces it must bound and sanitize it. Absent → no live chunks.
   */
  onTesterOutput?: (chunk: HeadlessOutputChunk) => void;
  /**
   * Per-target Tester progress (Task 13 mirror): forwarded verbatim into
   * `runUatTester` so the host can push the same inside-progress overlay the
   * gates use. Absent → no events.
   */
  onTesterTargetProgress?: (event: {
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
  /**
   * The composed `karst context` prefix (Prompt 17, § context loader) —
   * threaded verbatim into the Tester's tier-1 pointer line. An opaque
   * already-assembled string (never CLI entry/db/manifest paths threaded
   * separately — host-agnostic invariant). Absent → the Tester prompt carries
   * no pointer line.
   */
  contextCommand?: string;
}

/**
 * The injected spin seam — `runtime/spin.ts`'s `spinTicket` in production
 * (wired by `workflow/driveTicket.ts`). A ticket's runnable services are started
 * here, before the Tester, and stopped again afterwards (D155). Absent → no
 * spin at all, exactly like an absent Tester: unit tests and the dashboard's
 * gate-option resolver inject none.
 */
export type UatSpin = (
  store: Store,
  manifest: Manifest,
  ticketId: number,
  hot: string[],
  opts?: { signal?: AbortSignal; debug?: (message: string) => void },
) => Promise<SpinResult>;

/** The injected stop seam — `runtime/supervisor.ts`'s `stopTicketServers`. */
export type UatStopServers = (store: Store, ticketId: number) => Promise<void>;

export interface UatDeps {
  planTargets?: typeof planUatTargets;
  probe?: (cwd: string, debug?: (message: string) => void) => ScriptProbe;
  runGates?: typeof runGateList;
  git?: GitRunner;
  now?: () => string;
  /**
   * The Tester process (Task 8): its immutable assignment snapshot and the
   * already instrumented per-ticket adapter. Absent → no Tester runs at all:
   * UAT's ordinary gates (and the verifier, when configured) decide alone,
   * and the Tester's advisory observations are simply absent.
   */
  tester?: { assignment: ProcessAssignmentSnapshot; adapter: AgentAdapter };
  /**
   * Start the ticket's runnable services before the Tester, so the Tester can
   * exercise a live app instead of a bare worktree (D155). The worktrees
   * already exist, so the spin adopts them. Absent, or no runnable repository
   * in scope, or no Tester → no spin and no stop, and the stage runs exactly as
   * before. A spin failure parks `boot-failed` (an environment fault, never a
   * failed verdict); a cancel is a Stop.
   */
  spin?: UatSpin;
  /**
   * Stop every server of the ticket after the Tester, on every exit path
   * (pass, fail, unreadable, throw). Only called when THIS run spun the stack —
   * a stack the user already started is theirs and is left alone. Absent → no
   * stop (unit tests, the dashboard's gate-option resolver).
   */
  stopServers?: UatStopServers;
  /**
   * Sandboxed ticket (arch:AC-32 decision 7): user UAT uses the SAME instance
   * the Tester used, so a stack THIS run started is kept running after a
   * passed verdict instead of stopped. Absent / false → stopped, as before.
   */
  keepStackForUserUat?: (ticketId: number) => boolean;
  /**
   * Between agent and user UAT (decision 8): run each kept service's declared
   * `reset`. Resolves to warnings (a failed reset); absent → no reset.
   */
  prepareUserUat?: (store: Store, ticketId: number) => Promise<string[]>;
  /** The agent UAT window: the user UAT link is withheld from `start` until `end` (decision 7). */
  agentUatPhase?: (ticketId: number, phase: 'start' | 'end') => void;
  /**
   * The host gate boundary for the optional `uat.testerVerifier` (Task 8) —
   * `runProcess` from `workflow/gates/run.ts`. Absent with a configured
   * verifier, the stage parks (the verifier could not be asked).
   */
  runVerifier?: TesterGateRunner;
  /**
   * Pre-gate lockfile-drift check for npm script gates (defaults to
   * `checkNodeDeps`). An injected seam so unit tests never spawn npm.
   */
  checkDeps?: (cwd: string) => Promise<NodeDepsCheck>;
  /** Where the Tester's boundary diagnostics land (a failed AI call, garbage output). */
  warn?: WarnFn;
  /** Seam over the baseline-review change detection (@arch:BASELINE-REVIEW). */
  detectBaselines?: typeof detectTicketBaselines;
  /** Seam over the working-tree fingerprint the gate-skip is keyed on. */
  fingerprint?: typeof fingerprintTicket;
}

/** What a gate invocation IS, as a dedup key: the command, not the label on it. */
function identityKey(gate: ResolvedGate): string {
  return [gate.command, ...gate.args].join('\u0000');
}

/**
 * The gates for ONE target, which may back several manifest entries.
 *
 * `planUatTargets` collapses entries sharing a `repoPath` into one worktree, and
 * `declaredGatesFor` is keyed by a single repository NAME — so reading only the
 * first name would silently drop the second entry's `uat.repositories.<name>.gates`
 * override. Every name is resolved and the results unioned.
 *
 * Deduplicated by invocation identity, not by gate name: two entries in one
 * directory declaring `npm run e2e` are one question asked twice, and the same
 * identity is what `aggregate.ts` reduces over. A duplicate that is `required`
 * anywhere stays required — a configured gate whose script is missing must fail
 * rather than be skipped.
 *
 * Unavailable is only the answer when NO name produced a gate: a repository with
 * one runnable entry can still be asked something. The first unavailability wins,
 * since one probe backs every name and they therefore agree.
 *
 * `disabledNames` (optional, defaults to none) is the ticket's own cut, applied
 * ONCE over the deduplicated union — filtering earlier would report the same
 * disabled gate several times for a worktree backing several repository entries.
 *
 * Exported so `resolveTargetGates` is directly testable, mirroring
 * `resolveReviewGates`'s export in `review/gates.ts`.
 */
export function resolveTargetGates(
  probe: ScriptProbe,
  config: UatConfig | undefined,
  names: readonly string[],
  disabledNames: readonly string[] = [],
  debug?: (message: string) => void,
): StageGateResolution {
  const keys: (string | null)[] = names.length > 0 ? [...names] : [null];
  const byIdentity = new Map<string, ResolvedGate>();
  const configOff = new Map<string, ResolvedGate>();
  let unavailable: Extract<GateResolution, { kind: 'unavailable' }> | null = null;

  for (const name of keys) {
    const sw = applyConfigSwitch(declaredGatesFor(config, name), config?.probeWhenAllDisabled);
    const offNames = new Set(sw.disabledNames);
    const resolved = resolveGates(probe, sw.declared, PROBE_SCRIPTS, debug);
    if (resolved.kind === 'unavailable') {
      unavailable ??= resolved;
      continue;
    }
    for (const gate of resolved.gates) {
      const key = identityKey(gate);
      // Config-off is per entry: the same name enabled for another repository
      // entry still runs there, so it is judged by identity after the union.
      if (offNames.has(gate.name)) {
        configOff.set(key, gate);
        continue;
      }
      const existing = byIdentity.get(key);
      if (existing === undefined) byIdentity.set(key, gate);
      else if (gate.required && !existing.required) {
        byIdentity.set(key, { ...existing, required: true });
      }
    }
  }

  const ticketCut = partitionDisabled([...byIdentity.values()], disabledNames, debug);
  const kept = ticketCut.kept;
  const skipped = [
    ...ticketCut.skipped,
    ...[...configOff].filter(([key]) => !byIdentity.has(key)).map(([, gate]) => gate),
  ];
  if (kept.length > 0 || skipped.length > 0) {
    debug?.(
      `[gate] uat resolve: ${kept.length} kept, ${skipped.length} disabled for this ticket ` +
        `(disabled: ${skipped.map((g) => g.name).join(', ') || 'none'})`,
    );
    return { kind: 'gates', gates: kept, skipped };
  }
  // Zero gates, nothing disabled, and no unavailability is the malformed-
  // package.json case, which the caller turns into a named failure rather than
  // a park.
  debug?.(
    unavailable
      ? `[gate] uat resolve: zero gates — unavailable (${unavailable.blocker}: ${unavailable.reason})`
      : `[gate] uat resolve: zero gates resolved for names ${keys.join(', ')}`,
  );
  return unavailable ?? { kind: 'gates', gates: [], skipped: [] };
}

export async function runUat(
  store: Store,
  opts: RunUatOpts,
  deps: UatDeps = {},
): Promise<StageRunResult> {
  const now = deps.now ?? nowIso;
  const planTargets = deps.planTargets ?? planUatTargets;
  const probe = deps.probe ?? probeScripts;
  const runGates = deps.runGates ?? runGateList;
  const checkDeps = deps.checkDeps ?? checkNodeDeps;
  const git = deps.git ?? defaultGitRunner;
  const runAt = now();

  // Opened BEFORE anything runs, and durable. Everything below appends to it as
  // it happens: a host restart mid-run must leave a readable record that this
  // run existed and what it had already learned, since process death fires no
  // abort signal and the `stopped` path therefore never runs.
  const evidence = openGateRun(store, {
    ticketId: opts.ticketId,
    stageKey: 'uat',
    runAt,
    manifest: opts.manifest,
    pid: process.pid,
    debug: opts.debug,
  });

  const rerun = opts.rerun;
  const tester = rerun?.tester ?? deps.tester;
  const worktrees = opts.manifest || rerun ? listWorktreesByTicket(store, opts.ticketId) : [];

  const entries: AggregateEntry[] = rerun ? gateEntriesFrom(rerun.previousGateRuns) : [];
  // Read once, from review's latest RECORDED batch (Task 10) — not a fixed
  // gate list, since `review.gates` is configurable (Task 9) and only what
  // review actually invoked can prove the overlap this warns about.
  const reviewIdentities: GateIdentity[] = reviewIdentitiesFrom(listGateRuns(store, opts.ticketId));
  const sections: string[] = [];
  // Read from the store at RESOLUTION time, never from anything cached: a
  // toggle flipped mid-session must take effect on the very next gate run,
  // which is the same live-read property `opts.manifest`'s getter gives the
  // manifest itself.
  const disabledNames = getDisabledGates(store, opts.ticketId).uat;
  // The BARE gate names, kept beside the evidence rows rather than recovered
  // from them: a row's `gateName` is repo-decorated ("test (web)") because that
  // is what identifies an invocation, and the block reason already parenthesizes
  // the list — reusing it there nests the parentheses.
  const skippedNames: string[] = rerun
    ? rerun.previousGateRuns.filter((r) => r.skipped).map((r) => r.gateName)
    : [];
  // Set when the Tester runs: the process run the verifier failure is
  // attributed to (Task 8). Null until then, so a plain gate failure — or a
  // run that never reached the Tester — names no process.
  let testerRunId: number | null = null;

  /**
   * The recovery trigger for this run's outcome (v30), constructed HERE while
   * the failing evidence, the current stage run and the manifest cap are all
   * still in hand — never reconstructed later from `stages.verdict` or the
   * live manifest. A deterministic failed gate is its own source: `gates`,
   * with no AI process run. A completed nonzero `testerVerifier` exit is the
   * Tester PROCESS's failure: `tester`, carrying the Tester run's id — and so
   * is an observation at or above `uat.testerObservations.blockingSeverity`
   * (default `'none'`, which produces no such verdict at all). Blocks, stops
   * and passes carry no trigger.
   */
  const recoveryTriggerFor = (outcome: RunOutcome): RecoveryTriggerInput | null => {
    if (outcome.kind !== 'verdict' || outcome.verdict.kind !== 'failed') return null;
    const triggerDetail = outcome.verdict.reason ?? 'uat gates failed';
    const fromVerifier = triggerDetail.startsWith(TESTER_VERIFIER_FAILURE_PREFIX);
    const fromObservations = triggerDetail.startsWith(TESTER_OBSERVATIONS_FAILURE_PREFIX);
    const fromTester = fromVerifier || fromObservations;
    return {
      sourceProcessId: fromTester ? 'tester' : 'gates',
      sourceStageRunId: evidence.runId,
      sourceProcessRunId: fromTester ? testerRunId : null,
      triggerKind: fromVerifier
        ? 'tester-verifier-failure'
        : fromObservations
          ? 'blocking-tester-observations'
          : 'gate-failure',
      triggerDetail,
      maxRounds: capForGate('uat', opts.manifest?.uat?.maxFixAttempts, opts.manifest?.review?.maxFixAttempts),
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
  let verdictPassed = false;
  const finish = (outcome: RunOutcome, notes: readonly string[] = []): StageRunResult => {
    verdictPassed = outcome.kind === 'verdict' && outcome.verdict.kind === 'passed';
    // A host with no artifact directory configured passes '' — `mkdirSync('')` throws.
    let artifactPath = '';
    if (opts.artifactDir) {
      mkdirSync(opts.artifactDir, { recursive: true });
      artifactPath = join(opts.artifactDir, `uat-ticket-${opts.ticketId}-${evidence.runId}.log`);
      writeFileSync(artifactPath, [...notes.map((note) => `! ${note}`), ...sections].join('\n\n'));
    }
    return commitGateOutcome(store, {
      ticketId: opts.ticketId,
      stageKey: 'uat',
      runAt,
      artifactPath,
      gates: [],
      outcome,
      stageRunId: evidence.runId,
      recoveryTrigger: recoveryTriggerFor(outcome) ?? undefined,
      now,
      debug: opts.debug,
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
        // v21 invocation identity — what review's R7 compares its own gates
        // against, so this side must carry exactly what actually ran.
        repo: entry.identity.repo,
        command: entry.identity.command,
        args: entry.identity.args,
        // v46: a bounded excerpt of what the failing gate printed — the data a
        // fix session (or `karst context`) reads back instead of the log.
        // A refused host gate has no exit code; its reason is kept so the next
        // run can tell a repeated refusal from a new one.
        summary:
          entry.result.hostRefused === true
            ? entry.result.output
            : entry.result.exitCode !== null && entry.result.exitCode !== 0
              ? summarizeGateFailure(entry.result.output)
              : null,
      })),
    );
  };

  // A re-run never plans: it asks exactly the parked lane's targets, and never
  // tests another repository's checkout under a target's name.
  const unresolved = rerun ? unresolvedTargets(worktrees, rerun.targets, opts.cwd) : [];
  const planned = rerun
    ? unresolved.length > 0
      ? {
          kind: 'unavailable' as const,
          blocker: 'nothing-to-run' as const,
          reason:
            `${unresolved.join(', ')}: no worktree is registered for this ticket, ` +
            'so there is no tree to test — re-scope the ticket',
        }
      : {
          kind: 'targets' as const,
          targets: rerun.targets.map((repo) => ({
            repo,
            path: targetTree(worktrees, repo, opts.cwd)!.path,
            names: manifestNamesFor(opts.manifest, repo),
          })),
          unmapped: [],
        }
    : opts.manifest
    ? await planTargets(opts.manifest, worktrees, git, { store, ticketId: opts.ticketId }, opts.debug)
    : {
        kind: 'targets' as const,
        targets: [{ repo: opts.cwd, path: opts.cwd, names: [] }],
        unmapped: [],
      };

  // Environmental: karst could not even determine which repositories are
  // affected (an unreachable remote, a broken git) — never a verdict about the
  // ticket's code, so this parks rather than transitioning or throwing. Nothing
  // has run yet, so there is no partial evidence to keep.
  if (planned.kind === 'unavailable') {
    opts.debug?.(
      `[gate] uat ticket ${opts.ticketId}: targets unavailable (${planned.blocker}: ${planned.reason})`,
    );
    return finish({ kind: 'blocked', blocker: planned.blocker, reason: planned.reason }, [
      planned.reason,
    ]);
  }
  const targets: UatTarget[] = planned.targets;
  opts.debug?.(
    `[gate] uat ticket ${opts.ticketId}: planned ${targets.length} target(s) ` +
      `(manifest ${opts.manifest ? 'present' : 'absent'}, ${worktrees.length} worktree(s) registered)`,
  );

  if (targets.length === 0) {
    // Zero worktrees is not "nothing changed": nothing was ASKED. The ticket
    // has no repository to run UAT against at all, and passing here would walk
    // a stage that ran nothing straight to review — the vacuous green the
    // "asked nothing is never green" invariant exists to prevent. Resumable:
    // registering a worktree (re-scoping) makes a retry succeed.
    if (worktrees.length === 0) {
      const reason =
        'no worktree is registered for this ticket, so there is no repository to run UAT against';
      opts.debug?.(`[gate] uat ticket ${opts.ticketId}: zero targets — no worktree registered`);
      return finish({ kind: 'blocked', blocker: 'nothing-to-run', reason }, [reason]);
    }
    // Two situations that must not read as one. If any worktree matched no
    // manifest entry, karst could not ask that repository anything and a retry
    // cannot change the answer — only the user editing karst.yml or re-scoping
    // the ticket can, so this parks. If every worktree mapped and none has
    // changes from its base, the question WAS asked and the answer is "nothing
    // to check": that is a deliverable the stage already has, so it passes
    // with a note rather than parking forever behind a Resume that
    // reproduces the same block.
    if (planned.unmapped.length > 0) {
      const reason =
        `these worktrees match no repository in karst.yml: ${planned.unmapped.join(', ')} — ` +
        'add them to `repositories:` or re-scope the ticket';
      opts.debug?.(
        `[gate] uat ticket ${opts.ticketId}: zero targets — ${planned.unmapped.length} worktree(s) unmapped`,
      );
      return finish({ kind: 'blocked', blocker: 'unmapped-repository', reason }, [reason]);
    }
    const note = 'no repository has changes from its base, so UAT had nothing to check';
    opts.debug?.(`[gate] uat ticket ${opts.ticketId}: zero targets — nothing changed from base`);
    return finish({ kind: 'verdict', verdict: { kind: 'passed' } }, [note]);
  }

  // Re-entry after the user approved a baseline: when the working tree is
  // byte-identical to the one whose gate list already PASSED in this attempt,
  // the (slow, docker) gate list is not run again — straight to the baseline
  // check and the Tester. Opt-in with the baseline knob; any code change alters
  // the fingerprint and runs everything.
  const baselineReviewOn = (opts.manifest?.uat?.baselineReview?.paths.length ?? 0) > 0;
  const uatAttempt = stageAttempt(store, opts.ticketId, 'uat');
  let fingerprint: string | null = null;
  if (baselineReviewOn && opts.manifest && !rerun) {
    fingerprint = await (deps.fingerprint ?? fingerprintTicket)(
      store, opts.manifest, opts.ticketId, targets, { git },
    );
  }
  const skipGates = fingerprint !== null && hasUatGatePass(store, opts.ticketId, uatAttempt, fingerprint);
  opts.debug?.(
    `[gate] uat ticket ${opts.ticketId}: gate fingerprint ${fingerprint === null ? 'n/a' : fingerprint.slice(0, 12)} → ` +
      (skipGates ? 'unchanged since the gates passed, skipping the gate list' : 'running the gate list'),
  );

  for (const target of skipGates || rerun ? [] : targets) {
    const label = target.names.join(', ') || target.repo;
    const scriptProbe = probe(target.path, opts.debug);
    let resolution = resolveTargetGates(scriptProbe, opts.manifest?.uat, target.names, disabledNames, opts.debug);

    if (resolution.kind === 'unavailable') {
      // The zero-gate verdict is decided ACROSS every target, so "this
      // repository answers none of UAT's questions" is not a park on its own —
      // it is one target contributing no entry, and `aggregateUat` blocks
      // `nothing-to-run` only if NO target contributed one. Returning here
      // instead would discard the green of a target already run, never probe
      // the ones after it, make the outcome depend on target order, and leave
      // every mixed-stack ticket (a docs package beside a web package, anything
      // without a package.json — `absent` resolves here too) permanently
      // unprogressable. It is still recorded: an absence a human cannot see
      // reads the same as a repository karst never met. Mirrors review's own
      // `nothing-to-run → continue` branch (`stages/review.ts`).
      if (resolution.blocker === 'nothing-to-run') {
        opts.debug?.(
          `[gate] uat ticket ${opts.ticketId}: target ${label} has nothing to run ` +
            `(${resolution.reason})`,
        );
        sections.push(`# ${label} (nothing to run)\n${resolution.reason}`);
        continue;
      }

      // Environmental: karst could not READ this repository. That is not a
      // verdict about the ticket's code, a human has to act on it, and no other
      // target's green answers it — so it parks, and the completed targets'
      // rows go down with the park.
      const reason = `${label}: ${resolution.reason}`;
      opts.debug?.(
        `[gate] uat ticket ${opts.ticketId}: target ${label} unreadable ` +
          `(${resolution.blocker}: ${resolution.reason})`,
      );
      return finish({ kind: 'blocked', blocker: resolution.blocker, reason }, [reason]);
    }

    // A branch with no UI path in its diff has nothing for the container-pinned
    // visual/layout gates to say: they record `skipped` (evidence, not a pass).
    // No manifest means no real base ref (HEAD would diff as empty): keep every gate.
    const uiCut = opts.manifest
      ? await cutGatesWithoutUiChange(
          resolution.gates,
          git,
          target.path,
          resolveTicketBaseRef(store, opts.ticketId, target.repo, opts.manifest),
          opts.debug,
        )
      : { kept: [...resolution.gates], skipped: [] as ResolvedGate[] };
    resolution = { ...resolution, gates: uiCut.kept, skipped: [...resolution.skipped, ...uiCut.skipped] };
    const uiSkipped = new Set(uiCut.skipped);

    // One row per gate the user switched off, carrying the identity it WOULD
    // have been invoked with. No timing and no exit code, because none exists —
    // `skipped` is what states the difference from a missing script.
    for (const gate of resolution.skipped) {
      // Kept OUT of `entries`: a skipped gate must not reach `aggregateUat` as
      // an entry, where an exit-code-null row reads as "the repo has no such
      // script". It is evidence, not a question that was asked.
      evidence.append([{
        gateName: `${gate.name} (${label})`,
        exitCode: null,
        startedAt: null,
        endedAt: null,
        repo: target.repo,
        command: gate.command,
        args: gate.args,
        skipped: true,
      }]);
      skippedNames.push(gate.name);
      sections.push(
        `# ${gate.name} (${label}, skipped)\n${uiSkipped.has(gate) ? NO_UI_CHANGE_REASON : 'disabled for this ticket'}`,
      );
    }

    // A malformed package.json resolves to zero gates and IS a failure about the
    // repository — an agent can fix it, so it must reach a verdict.
    if (resolution.gates.length === 0 && scriptProbe.kind === 'malformed') {
      const malformed: AggregateEntry = {
        result: {
          name: `package.json (${label})`,
          exitCode: 1,
          output: `${label}: package.json is malformed — ${scriptProbe.message}`,
          startedAt: runAt,
          endedAt: runAt,
        },
        identity: { repo: target.repo, command: 'node', args: ['--parse-package-json'] },
      };
      entries.push(malformed);
      recordEntries([malformed]);
      sections.push(`# package.json (${label}, exit 1)\n${scriptProbe.message}`);
      continue;
    }

    // A dependency tree that drifted from the lockfile is a SETUP failure, not
    // a code verdict: every gate in a resolve-up worktree fails identically at
    // once, which reads as a pre-existing repo regression. Park (no attempt
    // consumed) and name the repair instead of attributing it to the ticket.
    if (resolution.gates.some((g) => g.script !== null)) {
      const depsCheck = await checkDeps(target.path, {
        signal: opts.signal,
        onDebug: opts.debug,
        repoRoot: target.repo,
      });
      if (!depsCheck.ok) {
        const repairDir = depsCheck.dir ?? target.path;
        const reason =
          depsCheck.kind === 'dependency-drift'
            ? `${label}: installed dependencies are inconsistent with package-lock.json — ` +
              `${depsCheck.reason} — run 'npm install' (or 'npm ci') in ${repairDir}`
            : `${label}: could not verify installed dependencies — ${depsCheck.reason}`;
        opts.debug?.(
          `[gate] uat ticket ${opts.ticketId}: target ${label} ${depsCheck.kind} (${depsCheck.reason})`,
        );
        return finish({ kind: 'blocked', blocker: 'capability-missing', reason }, [reason]);
      }
    }

    const scripts = scriptProbe.kind === 'ok' ? scriptProbe.scripts : {};
    const stageBaseRef = opts.manifest
      ? resolveTicketBaseRef(store, opts.ticketId, target.repo, opts.manifest)
      : 'HEAD';
    opts.debug?.(
      `[gate] uat ticket ${opts.ticketId}: target ${label} — ${resolution.gates.length} gate(s)` +
        (resolution.skipped.length > 0 ? `, ${resolution.skipped.length} disabled` : ''),
    );
    const run = await runGates(withHostOverride(resolution.gates, getHostGates(store, opts.ticketId)), target.path, {
      signal: opts.signal,
      now,
      scriptsAvailable: (script, derived) =>
        scriptProbe.kind === 'ok' ? scripts[script] !== undefined : derived,
      baseRef: stageBaseRef,
      ...regenerateOption(opts.manifest, target, opts.debug),
      // No manifest means no real base ref: HEAD is the branch itself, so skip the lookup.
      ...(opts.manifest
        ? { baseDefinesScript: (script: string) => baseDefinesScript(git, target.path, stageBaseRef, script) }
        : {}),
      onGateStart: opts.onGateStart,
      onGateOutput: opts.onGateOutput,
      onDebug: opts.debug,
      // Each gate row is appended the INSTANT that gate finishes — inside the
      // runner's own loop, before the next gate starts. A host death between
      // two gates (process death fires no abort signal, so the `stopped` path
      // never runs) must still leave every finished gate readable; batching
      // until the target's list completed was what threw a run's worth of
      // rows away with it. Zipped by POSITION like the aggregation below: two
      // manifest entries sharing a worktree can declare the same gate name, so
      // a name lookup would attach the wrong identity to the row.
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
        // A drift-passed gate exits 0 but prints the shared alert line (D360).
        raiseDevelopRedAlert(store, opts.ticketId, output ?? '');
        opts.onGateComplete?.(name, exitCode);
      },
    });

    const produced: AggregateEntry[] = [];
    const regenFailed = 'regenerateFailed' in run;
    for (const [index, result] of run.results.entries()) {
      // A failed regenerate is the pass's only result; it is not one of the resolved gates.
      const gate = regenFailed ? undefined : resolution.gates[index];
      produced.push({
        result: regenFailed ? result : { ...result, name: `${result.name} (${label})` },
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
    // recorded — discarding it would make work that really happened unrecoverable.
    if (run.kind === 'stopped') {
      return finish({ kind: 'stopped' }, ['stopped before every gate finished']);
    }
  }

  const outcome: ReturnType<typeof aggregateUat> = skipGates && !rerun
    ? { kind: 'verdict', verdict: { kind: 'passed' }, warnings: [] }
    : aggregateUat(
    entries,
    reviewIdentities,
    skippedNames,
  );
  opts.debug?.(
    `[gate] uat ticket ${opts.ticketId}: aggregate over ${entries.length} entry(ies)` +
      `${skippedNames.length > 0 ? `, ${skippedNames.length} skipped` : ''} → ` +
      (outcome.kind === 'blocked'
        ? `blocked (${outcome.blocker}: ${outcome.reason})`
        : `verdict ${outcome.verdict.kind}${
            outcome.verdict.kind === 'failed' && outcome.verdict.reason
              ? ` (${outcome.verdict.reason})`
              : ''
          }`),
  );
  if (outcome.kind === 'blocked') {
    const reason = entries.some((e) => e.result.hostRefused === true)
      ? escalatedRefusalReason(outcome.reason, hostRefusalRepeats(store, opts.ticketId, 'uat', evidence.runId), opts.cwd)
      : outcome.reason;
    return finish({ kind: 'blocked', blocker: outcome.blocker, reason }, [reason]);
  }
  // A failed gate verdict is decided and closed exactly as before — the Tester
  // never runs, because it only ever runs after the required gates PASS.
  if (outcome.verdict.kind === 'failed') {
    return finish({ kind: 'verdict', verdict: outcome.verdict }, outcome.warnings);
  }

  // The gate list passed for THIS working tree: remember it so a re-entry after
  // a baseline approval does not run it again.
  if (fingerprint !== null && !skipGates) {
    recordUatGatePass(store, { ticketId: opts.ticketId, attempt: uatAttempt, fingerprint, runAt });
  }

  // ---- Baseline review (@arch:BASELINE-REVIEW) ----
  // Only after the required gates PASSED (a failing build goes to fix first) and
  // before the Tester: a baseline the ticket changed counts only once the USER
  // approved it in the UAT report. The agent re-recording its own screenshots
  // must never pass itself. Opt-in: no `uat.baselineReview.paths`, no check.
  if ((opts.manifest?.uat?.baselineReview?.paths.length ?? 0) > 0) {
    const detect = deps.detectBaselines ?? detectTicketBaselines;
    opts.debug?.(`[gate] uat ticket ${opts.ticketId}: baseline review — detecting changed baselines`);
    let changed;
    try {
      changed = await detect(store, opts.manifest, opts.ticketId, targets, { git });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      opts.debug?.(`[gate] uat ticket ${opts.ticketId}: baseline review could not ask (${reason})`);
      return finish({ kind: 'blocked', blocker: 'capability-missing', reason }, [reason]);
    }
    const pending = unapprovedBaselines(changed, latestBaselineDecisions(store, opts.ticketId));
    opts.debug?.(
      `[gate] uat ticket ${opts.ticketId}: baseline review — ${changed.length} changed, ` +
        `${pending.length} unapproved → ${pending.length > 0 ? 'blocked (baseline-review)' : 'proceed'}`,
    );
    if (pending.length > 0) {
      const reason = `${pending.length} visual baseline(s) changed — review in the UAT report`;
      sections.push(
        `# baseline review\n${pending.map((e) => `${e.status} ${e.repo}:${e.path}`).join('\n')}`,
      );
      return finish({ kind: 'blocked', blocker: 'baseline-review', reason }, [reason]);
    }
  }

  // ---- Spin the ticket's services before the Tester (D155) ----
  // Browser UAT is blocked on every multi-service ticket unless something
  // starts the app the Tester exercises. The worktrees already exist, so the
  // spin adopts them; the manifest's baseline dependencies come up through
  // `ensureBaseline`. Read from the store, never from anything cached: a row a
  // prior run stopped still reads `stopped` here.
  //
  // A ticket whose runnable services the user ALREADY started owns that stack:
  // karst neither spins it nor stops it afterwards. Anything less than the whole
  // stack is UAT's — the spin stops every ticket server first (spin.ts), so a
  // partial user-started stack is not restored afterwards (deliberate).
  const ticket = getTicket(store, opts.ticketId);
  const spinFn = deps.spin;
  const stopFn = deps.stopServers;
  const spinManifest = opts.manifest;
  // Set when THIS run starts the stack (or tries to): the `finally` below stops
  // it on every exit path, INCLUDING a spin that failed partway — `spinTicket`
  // leaves the services it already started running on a non-cancel failure, and
  // an un-stopped stack is a leaked dev server on a port karst believes is free.
  let ownsStack = false;
  let spinHot: string[] = [];
  // BOTH seams must be present: a spin with no way to stop would leak the
  // stack it started, so an absent stop disables the capability entirely.
  if (tester && spinFn && stopFn && spinManifest !== undefined) {
    const hot = runnableSubset(spinManifest, ticket.selectedRepos);
    if (hot.length > 0) {
      const running = new Set(
        listServersByTicket(store, opts.ticketId)
          .filter((s) => s.status === 'running')
          .map((s) => s.service),
      );
      const needed = unitsOfRepos(spinManifest, hot).map((u) => u.key);
      if (needed.length > 0 && needed.every((key) => running.has(key))) {
        opts.debug?.(
          `[gate] uat ticket ${opts.ticketId}: ${needed.length} service(s) already running — ` +
            `reusing the user's stack, no spin and no stop`,
        );
      } else {
        ownsStack = true;
        spinHot = hot;
      }
    }
  }

  /**
   * The post-gates half of the stage: the Tester, its optional deterministic
   * verifier, and the final verdict. Extracted so the WHOLE half runs under one
   * `finally` that stops the services UAT started — on every exit path (pass,
   * fail, unreadable, or a throw). A stack the user already started is not ours
   * and is never stopped.
   */
  const finishAfterServices = async (): Promise<StageRunResult> => {
    // ---- Tester + optional deterministic verifier (Task 8) ----
    // The AI Tester contributes OBSERVATIONS only: its findings can never pass,
    // fail, transition, or spend a recovery round by themselves. The optional
    // `uat.testerVerifier` is the deterministic boundary whose COMPLETED exit
    // code is the sole Tester-specific DETERMINISTIC verdict; the one way an
    // observation itself becomes a verdict is the opt-in
    // `uat.testerObservations.blockingSeverity` applied below. At its default
    // `'none'` the observations are advisory and this gate verdict decides.
    let testerResult: TesterRunResult | null = null;
    const testerOnSkip = opts.manifest?.uat?.testerObservations?.onSkip ?? UAT_TESTER_ON_SKIP;
    if (tester) {
      // Source fields: `Ticket.description` / `intent` — the ticket's done-when
      // criteria (Prompt 17). The ticket was read once, above, via the existing
      // accessor: no new injected dependency, no `vscode` import (host-agnostic
      // invariant intact).
      testerResult = await runUatTester(
        store,
        {
          ticketId: opts.ticketId,
          targets: testerTargets(
            opts.manifest,
            targets,
            worktrees,
            listServersByTicket(store, opts.ticketId),
          ),
          assignment: tester.assignment,
          adapter: tester.adapter,
          stageRunId: evidence.runId,
          attempt: evidence.attempt,
          signal: opts.signal,
          warn: deps.warn,
          debug: opts.debug,
          git,
          criteria: ticket.description,
          intent: ticket.intent,
          ticketKey: ticket.key,
          contextCommand: opts.contextCommand,
          onOutput: opts.onTesterOutput,
          onTargetProgress: opts.onTesterTargetProgress,
          // The ONE knob that can make an observation a verdict. Coalesced at
          // every read: the loader leaves the block undefined when absent but
          // materializes `{ blockingSeverity: 'none' }` when it is present and
          // empty, and both must read as the advisory default.
          observationsBlockingSeverity:
            opts.manifest?.uat?.testerObservations?.blockingSeverity ?? 'none',
          // T663: the per-target fresh-token budget. Absent → the Tester's own
          // default, so a manifest that omits `uat.tester` is unchanged.
          tokenBudget: opts.manifest?.uat?.tester?.tokenBudget,
          // Absent → 'pass': a skipped run is recorded and UAT passes on, as today.
          onSkip: testerOnSkip,
        },
        { now },
      );
    } else {
      opts.debug?.(
        `[gate] uat ticket ${opts.ticketId}: gates passed — no Tester configured, gates alone decide`,
      );
    }
    // The run was opened by `runUatTester` under the driver's single-flight;
    // read the id back so the verifier trigger can name the exact Tester
    // execution (a recovery round must never guess at its source process). Scope
    // to THIS attempt's stage run: `listProcessRuns` spans the ticket's whole
    // history, so an attempt that ran no Tester would otherwise attribute its
    // verifier failure to a stale tester run from an earlier attempt.
    for (const run of listProcessRuns(store, opts.ticketId).reverse()) {
      if (run.processId === 'tester' && run.stageRunId === evidence.runId) {
        testerRunId = run.id;
        break;
      }
    }
    if (testerResult?.kind === 'interrupted') {
      return finish({ kind: 'stopped' }, ['tester interrupted before it finished']);
    }
    if (rerun) {
      persistSiblingObservations(store, opts.ticketId, testerRunId, rerun.siblingObservations, now());
    }
    if (testerResult?.kind === 'execution-failed') {
      // Advisory absence, exactly like review's lane: a failed AI call must not
      // break the run's gates — it is reported, and the gates decide.
      deps.warn?.(`uat tester: call failed, contributing no observations: ${testerResult.message}`);
    }
    if (testerResult?.kind === 'partial') {
      // T663: the run was stopped by a budget or the deadline and reported what
      // it could. Advisory exactly like `observed` — the gates (and the verifier,
      // and the observation threshold below) decide — but the user is told the
      // result is partial, never left to read it as a clean pass.
      deps.warn?.(`uat tester: ${testerResult.detail}`);
    }
    if (testerResult?.kind === 'unreadable-output') {
      // NOT the same event as `execution-failed`. The call SUCCEEDED and the
      // agent answered — it just answered in a shape no findings could be read
      // out of. That answer may carry blocking observations nobody parsed, so
      // treating it as an advisory absence discards evidence rather than noting
      // one. By the time this branch runs, `runUatTester` has already given
      // every unreadable target ONE reformat nudge (quoting its own prose back,
      // asking only for the shape) — this is reached only when that retry also
      // came back unreadable. Park instead of passing: no `maxFixAttempts`
      // attempt is consumed and no recovery round opens for what may be a
      // formatting failure by the agent core rather than a defect in the ticket
      // — the ticket stops and waits for a human instead of advancing on
      // evidence nobody read. Mirrors review's own park for the identical
      // situation (`review.ts` ~line 675).
      //
      // This is a real, UNMEASURED-rate decision (UAT-19): the reformat-nudge
      // rate this park's trigger reads from is zero rows at ship time. If it
      // later reads high for one core (or the reformat nudge itself rarely
      // recovers a readable answer), the fallback is reverting this park to
      // advisory for that core — never tuning the nudge's wording first. See
      // `docs/arch/prompt-metrics.md` ("UAT-19's park rollback trigger").
      const reason = 'uat tester: every target answered unreadable output — nothing could be read out of it';
      sections.push(`# uat tester (unreadable output)\n${testerResult.preview}`);
      return finish({ kind: 'blocked', blocker: 'capability-missing', reason }, [reason]);
    }
    if (testerResult?.kind === 'skipped') {
      // The Tester checked nothing (twice, under the re-ask modes). The code was
      // NOT judged, so this is never a failed verdict or a fix round: under
      // `reask-then-park` the USER decides (Re-run tester / Accept skip).
      deps.warn?.(`uat tester: skipped — ${testerResult.detail}`);
      if (testerOnSkip === 'reask-then-park') {
        const reason = `tester observed nothing — ${testerResult.detail}`;
        sections.push(`# uat tester (skipped)\n${testerResult.detail}`);
        return finish({ kind: 'blocked', blocker: 'tester-skipped', reason }, [reason]);
      }
    }
    if (testerResult?.kind === 'usage-limited') {
      // K11: the provider account is out of quota/allowance. NOT an advisory
      // absence and NOT a T663 partial — the op could not run, so the stage
      // parks `blocked:usage-limit` (no verdict, no fix attempt) with the park
      // payload that rides into `usage_limit_parks`. The observations a sibling
      // target already produced are kept on the park row for D159's merge.
      const reason = usageLimitReason(testerResult.provider, testerResult.model);
      sections.push(`# uat tester (usage limit)\n${testerResult.detail}`);
      return finish(
        {
          kind: 'blocked',
          blocker: 'usage-limit',
          reason,
          park: {
            provider: testerResult.provider,
            model: testerResult.model,
            lane: 'uat',
            target: testerResult.target,
            detail: testerResult.detail,
            keptOutcome: rerun
              ? mergeUatKeptOutcome(testerResult.keptOutcome, rerun.siblingObservations, rerun.siblingTargets)
              : testerResult.keptOutcome,
          },
        },
        [reason, testerResult.detail],
      );
    }
  
    const verifierGate = opts.manifest?.uat?.testerVerifier;
    if (verifierGate !== undefined) {
      const verification = await runTesterVerifier(
        { gate: verifierGate, cwd: targets[0]?.path ?? opts.cwd, signal: opts.signal, onDebug: opts.debug },
        { run: deps.runVerifier },
      );
      switch (verification.kind) {
        case 'passed':
          break;
        case 'absent':
          // Unreachable when a gate was supplied; kept for exhaustiveness.
          break;
        case 'failed': {
          // A completed nonzero exit is a DETERMINISTIC validation failure: the
          // Tester's observation is disproven, the run records it, and the
          // failed verdict opens a recovery round naming the Tester process.
          if (testerRunId !== null) {
            setProcessRunResultKind(store, testerRunId, 'verification-failed');
          }
          const reason = `${TESTER_VERIFIER_FAILURE_PREFIX}exit code ${verification.exitCode}`;
          return finish({ kind: 'verdict', verdict: { kind: 'failed', reason } });
        }
        case 'execution-failed': {
          // A command that could not run is environmental: park, never a
          // verdict — no attempt is consumed and no recovery round opens.
          const reason =
            `uat tester verifier "${verifierGate.name}" could not run: ${verification.message}`;
          return finish({ kind: 'blocked', blocker: 'capability-missing', reason }, [reason]);
        }
        case 'interrupted':
          return finish({ kind: 'stopped' }, ['uat tester verifier interrupted']);
        default: {
          const unreachable: never = verification;
          throw new Error(`unrecognized verifier outcome: ${JSON.stringify(unreachable)}`);
        }
      }
    }
  
    // ---- The opt-in observation threshold (Task 3.2) ----
    // `uat.testerObservations.blockingSeverity` is the ONE way an OBSERVATION
    // becomes a verdict. At the default `'none'` — and for every manifest that
    // omits the block — `blocking` is 0 and this is dead code: the gates (and the
    // verifier, when configured) decide exactly as before. Placed AFTER the
    // verifier so the deterministic boundary keeps precedence, and expressed the
    // same way the verifier's failure is: a failed verdict whose reason carries
    // the shared prefix, which `recoveryTriggerFor` reads to attribute the
    // recovery round to `sourceProcessId: 'tester'`.
    // A re-run also counts the sibling observations the earlier park kept.
    const counted = rerun
      ? combinedBlocking(
          store,
          opts.ticketId,
          testerRunId,
          testerResult,
          rerun.siblingObservations,
          opts.manifest?.uat?.testerObservations?.blockingSeverity ?? 'none',
        )
      : testerResult?.kind === 'observed' || testerResult?.kind === 'partial'
        ? testerResult
        : { blocking: 0, blockingSummary: undefined };
    if (counted.blocking > 0) {
      const reason = `${TESTER_OBSERVATIONS_FAILURE_PREFIX}${counted.blockingSummary ?? `${counted.blocking} blocking`}`;
      opts.debug?.(
        `[gate] uat ticket ${opts.ticketId}: gates passed but ${counted.blocking} tester ` +
          `observation(s) are at or above the configured blocking severity — failing uat`,
      );
      return finish({ kind: 'verdict', verdict: { kind: 'failed', reason } }, outcome.warnings);
    }
  
    return finish({ kind: 'verdict', verdict: outcome.verdict }, outcome.warnings);
  };

  if (ownsStack) deps.agentUatPhase?.(opts.ticketId, 'start');
  try {
    // The spin is INSIDE this try so its `finally` covers a partial failure too:
    // `spinTicket` leaves the services it already started running when a later
    // one fails (only a cancel tears its own run down), so a `boot-failed` park
    // must still stop whatever came up. Idempotent, and a cancel already stopped
    // its own run — stopping again is a no-op.
    if (ownsStack && spinFn && spinManifest !== undefined) {
      opts.debug?.(
        `[gate] uat ticket ${opts.ticketId}: spinning ${spinHot.length} runnable repo(s) before the Tester`,
      );
      try {
        await spinFn(store, spinManifest, opts.ticketId, spinHot, {
          signal: opts.signal,
          debug: opts.debug,
        });
      } catch (error) {
        // A Stop is a cancel, never an environment fault.
        if (error instanceof SpinCancelledError) {
          opts.debug?.(`[gate] uat ticket ${opts.ticketId}: spin cancelled — stopped`);
          return finish({ kind: 'stopped' }, ['spin cancelled before the services came up']);
        }
        // An environment fault is a BLOCK, never a failed verdict: the code was
        // not judged, so a fix round would be spent on nothing. The reason
        // carries startHot's health evidence (nothing listening, or a listener
        // that never answered) plus the service's own log tail.
        const reason =
          `could not start the ticket's services: ` +
          (error instanceof Error ? error.message : String(error));
        opts.debug?.(`[gate] uat ticket ${opts.ticketId}: spin failed — parked boot-failed`);
        sections.push(`# services (spin failed)\n${reason}`);
        return finish({ kind: 'blocked', blocker: 'boot-failed', reason }, [reason]);
      }
    }
    return await finishAfterServices();
  } finally {
    // Decision 7: a sandboxed stack that passed agent UAT stays up for user
    // UAT — same instance — after its optional reset (decision 8).
    const keep = ownsStack && verdictPassed && deps.keepStackForUserUat?.(opts.ticketId) === true;
    if (keep) await resetForUserUat(store, opts.ticketId, deps, opts.debug);
    if (ownsStack) deps.agentUatPhase?.(opts.ticketId, 'end');
    // Stop the services UAT started on every exit path — the rows stay offline
    // so the dashboard offers Restart. Best-effort: a stop that cannot run must
    // never replace the stage's own outcome. A stack the user owns is untouched.
    if (ownsStack && stopFn && !keep) {
      try {
        await stopFn(store, opts.ticketId);
        opts.debug?.(`[gate] uat ticket ${opts.ticketId}: stopped the ticket's services after UAT`);
      } catch (error) {
        opts.debug?.(
          `[gate] uat ticket ${opts.ticketId}: stopping the ticket's services failed: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
}

/** Best-effort: a failed reset is a warning, never a change to the committed verdict. */
async function resetForUserUat(
  store: Store,
  ticketId: number,
  deps: UatDeps,
  debug: ((message: string) => void) | undefined,
): Promise<void> {
  try {
    const warnings = (await deps.prepareUserUat?.(store, ticketId)) ?? [];
    for (const w of warnings) deps.warn?.(`uat: ${w}`);
    debug?.(`[gate] uat ticket ${ticketId}: kept the sandboxed services for user UAT (${warnings.length} reset warning(s))`);
  } catch (error) {
    deps.warn?.(`uat: reset before user UAT failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The Tester's view of the planned targets: repo + worktree path (what the
 * prompt and parse containment need), the plain base branch (`worktrees.base_ref`),
 * and the host-known service context from the manifest — READ-ONLY, never AI
 * output. `repo` stays the repoPath exactly as the gates recorded it, so the
 * observation's attribution matches every other table's.
 */
export function testerTargets(
  manifest: Manifest | undefined,
  targets: readonly UatTarget[],
  worktrees: readonly { repo: string; baseRef: string | null; branch: string | null }[],
  servers: readonly ServerView[] = [],
): TesterTarget[] {
  const baseRefByRepo = new Map(worktrees.map((w) => [w.repo, w.baseRef]));
  const branchByRepo = new Map(worktrees.map((w) => [w.repo, w.branch]));
  return targets.map((t) => ({
    repo: t.repo,
    worktreePath: t.path,
    baseRef: baseRefByRepo.get(t.repo) ?? null,
    branch: branchByRepo.get(t.repo) ?? null,
    runningServices: runningServicesFor(manifest, t.names, servers),
    gates: declaredCheckGates(manifest, t.repo),
  }));
}

/**
 * The services of a target's repository names that are RUNNING right now, each
 * as `repo/service → http://host:port`, read from the ticket's server rows —
 * never from the manifest's start commands (the Tester must not start anything,
 * and a start command is not a live URL). A runnable repository with no running
 * row contributes nothing, and the prompt says its change is not live.
 */
function runningServicesFor(
  manifest: Manifest | undefined,
  names: readonly string[],
  servers: readonly ServerView[],
): TesterRunningService[] {
  const keys = new Set(
    names.flatMap((name) => {
      const repo = manifest?.repositories[name];
      return repo ? unitsOf(name, repo).map((u) => u.key) : [];
    }),
  );
  return servers
    .filter((s) => s.status === 'running' && s.host !== null && s.port !== null && keys.has(s.service))
    .map((s) => ({ key: s.service, url: `http://${s.host}:${s.port}` }));
}
