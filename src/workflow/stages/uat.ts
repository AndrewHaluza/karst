import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { StageRunResult } from '../../model/types.js';
import type { Manifest, UatConfig } from '../../manifest/types.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import type { GateRunInput } from '../../store/gateRuns.js';
import { commitGateOutcome, type RunOutcome, type RecoveryTriggerInput } from '../gates/commit.js';
import { openGateRun } from '../gates/evidence.js';
import { nowIso } from '../../model/time.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { listProcessRuns, setProcessRunResultKind } from '../../store/processRuns.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { noTargetsReason } from '../gates/targets.js';
import { resolveGates, type GateResolution, type ResolvedGate } from '../gates/resolve.js';
import { partitionDisabled, type StageGateResolution } from '../gates/disable.js';
import { runGateList } from '../gates/runList.js';
import { planUatTargets, type UatTarget } from '../uat/targets.js';
import { declaredGatesFor, PROBE_SCRIPTS } from '../uat/gates.js';
import { runUatTester, type TesterTarget, type TesterRunResult } from '../uat/tester.js';
import {
  runTesterVerifier,
  TESTER_VERIFIER_FAILURE_PREFIX,
  type TesterGateRunner,
} from '../uat/testerVerifier.js';
import type { WarnFn } from '../review/findings.js';
import { getDisabledGates } from '../../store/ticketGates.js';
import { capForGate } from '../fixAttempts.js';
import {
  aggregateUat,
  reviewIdentitiesFrom,
  type AggregateEntry,
  type GateIdentity,
} from '../uat/aggregate.js';

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

export interface RunUatOpts {
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
}

export interface UatDeps {
  planTargets?: typeof planUatTargets;
  probe?: (cwd: string) => ScriptProbe;
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
   * The host gate boundary for the optional `uat.testerVerifier` (Task 8) —
   * `runProcess` from `workflow/gates/run.ts`. Absent with a configured
   * verifier, the stage parks (the verifier could not be asked).
   */
  runVerifier?: TesterGateRunner;
  /** Where the Tester's boundary diagnostics land (a failed AI call, garbage output). */
  warn?: WarnFn;
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
): StageGateResolution {
  const keys: (string | null)[] = names.length > 0 ? [...names] : [null];
  const byIdentity = new Map<string, ResolvedGate>();
  let unavailable: Extract<GateResolution, { kind: 'unavailable' }> | null = null;

  for (const name of keys) {
    const resolved = resolveGates(probe, declaredGatesFor(config, name), PROBE_SCRIPTS);
    if (resolved.kind === 'unavailable') {
      unavailable ??= resolved;
      continue;
    }
    for (const gate of resolved.gates) {
      const key = identityKey(gate);
      const existing = byIdentity.get(key);
      if (existing === undefined) byIdentity.set(key, gate);
      else if (gate.required && !existing.required) {
        byIdentity.set(key, { ...existing, required: true });
      }
    }
  }

  const { kept, skipped } = partitionDisabled([...byIdentity.values()], disabledNames);
  if (kept.length > 0 || skipped.length > 0) return { kind: 'gates', gates: kept, skipped };
  // Zero gates, nothing disabled, and no unavailability is the malformed-
  // package.json case, which the caller turns into a named failure rather than
  // a park.
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
  });

  const worktrees = opts.manifest ? listWorktreesByTicket(store, opts.ticketId) : [];

  const entries: AggregateEntry[] = [];
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
  const skippedNames: string[] = [];
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
   * Tester PROCESS's failure: `tester`, carrying the Tester run's id. Blocks,
   * stops and passes carry no trigger.
   */
  const recoveryTriggerFor = (outcome: RunOutcome): RecoveryTriggerInput | null => {
    if (outcome.kind !== 'verdict' || outcome.verdict.kind !== 'failed') return null;
    const triggerDetail = outcome.verdict.reason ?? 'uat gates failed';
    const fromVerifier = triggerDetail.startsWith(TESTER_VERIFIER_FAILURE_PREFIX);
    return {
      sourceProcessId: fromVerifier ? 'tester' : 'gates',
      sourceStageRunId: evidence.runId,
      sourceProcessRunId: fromVerifier ? testerRunId : null,
      triggerKind: fromVerifier ? 'tester-verifier-failure' : 'gate-failure',
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
  const finish = (outcome: RunOutcome, notes: readonly string[] = []): StageRunResult => {
    mkdirSync(opts.artifactDir, { recursive: true });
    const artifactPath = join(opts.artifactDir, `uat-ticket-${opts.ticketId}.log`);
    writeFileSync(artifactPath, [...notes.map((note) => `! ${note}`), ...sections].join('\n\n'));
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
      })),
    );
  };

  const planned = opts.manifest
    ? await planTargets(opts.manifest, worktrees, git)
    : { kind: 'targets' as const, targets: [{ repo: opts.cwd, path: opts.cwd, names: [] }] };

  // Environmental: karst could not even determine which repositories are
  // affected (an unreachable remote, a broken git) — never a verdict about the
  // ticket's code, so this parks rather than transitioning or throwing. Nothing
  // has run yet, so there is no partial evidence to keep.
  if (planned.kind === 'unavailable') {
    return finish({ kind: 'blocked', blocker: planned.blocker, reason: planned.reason }, [
      planned.reason,
    ]);
  }
  const targets: UatTarget[] = planned.targets;

  if (targets.length === 0) {
    const reason = noTargetsReason(worktrees, 'UAT');
    return finish({ kind: 'blocked', blocker: 'nothing-to-run', reason }, [reason]);
  }

  for (const target of targets) {
    const label = target.names.join(', ') || target.repo;
    const scriptProbe = probe(target.path);
    const resolution = resolveTargetGates(scriptProbe, opts.manifest?.uat, target.names, disabledNames);

    // Environmental: karst could not ask this repository anything. Park rather
    // than reduce — a block is not a verdict about the ticket's code. Earlier
    // targets already ran, so their rows go down with the park.
    if (resolution.kind === 'unavailable') {
      const reason = `${label}: ${resolution.reason}`;
      return finish({ kind: 'blocked', blocker: resolution.blocker, reason }, [reason]);
    }

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
      sections.push(`# ${gate.name} (${label}, skipped)\ndisabled for this ticket`);
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

    const scripts = scriptProbe.kind === 'ok' ? scriptProbe.scripts : {};
    const run = await runGates(resolution.gates, target.path, {
      signal: opts.signal,
      now,
      scriptsAvailable: (script) => scripts[script] !== undefined,
      onGateComplete: opts.onGateComplete,
      onGateStart: opts.onGateStart,
    });

    const produced: AggregateEntry[] = [];
    for (const [index, result] of run.results.entries()) {
      // Zipped by POSITION: `runGateList` emits one result per gate in order, and
      // two manifest entries sharing a worktree can declare the same gate name,
      // so a name lookup would attach the wrong identity to the row.
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
    // recorded — discarding it would make work that really happened unrecoverable.
    if (run.kind === 'stopped') {
      return finish({ kind: 'stopped' }, ['stopped before every gate finished']);
    }
  }

  const outcome = aggregateUat(
    entries,
    reviewIdentities,
    skippedNames,
  );
  if (outcome.kind === 'blocked') {
    return finish({ kind: 'blocked', blocker: outcome.blocker, reason: outcome.reason }, [
      outcome.reason,
    ]);
  }
  // A failed gate verdict is decided and closed exactly as before — the Tester
  // never runs, because it only ever runs after the required gates PASS.
  if (outcome.verdict.kind === 'failed') {
    return finish({ kind: 'verdict', verdict: outcome.verdict }, outcome.warnings);
  }

  // ---- Tester + optional deterministic verifier (Task 8) ----
  // The AI Tester contributes OBSERVATIONS only: its findings can never pass,
  // fail, transition, or spend a recovery round by themselves. The optional
  // `uat.testerVerifier` is the deterministic boundary whose COMPLETED exit
  // code is the sole Tester-specific verdict; without one, the Tester's
  // observations are advisory and this gate verdict decides progression.
  const testerResult: TesterRunResult | null = deps.tester
    ? await runUatTester(
        store,
        {
          ticketId: opts.ticketId,
          targets: testerTargets(opts.manifest, targets, worktrees),
          assignment: deps.tester.assignment,
          adapter: deps.tester.adapter,
          stageRunId: evidence.runId,
          attempt: evidence.attempt,
          signal: opts.signal,
          warn: deps.warn,
        },
        { now },
      )
    : null;
  // The run was opened by `runUatTester` under the driver's single-flight;
  // read the id back so the verifier trigger can name the exact Tester
  // execution (a recovery round must never guess at its source process).
  for (const run of listProcessRuns(store, opts.ticketId).reverse()) {
    if (run.processId === 'tester') {
      testerRunId = run.id;
      break;
    }
  }
  if (testerResult?.kind === 'interrupted') {
    return finish({ kind: 'stopped' }, ['tester interrupted before it finished']);
  }
  if (testerResult?.kind === 'execution-failed') {
    // Advisory absence, exactly like review's lane: a failed AI call must not
    // break the run's gates — it is reported, and the gates decide.
    deps.warn?.(`uat tester: call failed, contributing no observations: ${testerResult.message}`);
  }

  const verifierGate = opts.manifest?.uat?.testerVerifier;
  if (verifierGate !== undefined) {
    const verification = await runTesterVerifier(
      { gate: verifierGate, cwd: targets[0]?.path ?? opts.cwd, signal: opts.signal },
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

  return finish({ kind: 'verdict', verdict: outcome.verdict }, outcome.warnings);
}

/**
 * The Tester's view of the planned targets: repo + worktree path (what the
 * prompt and parse containment need), the plain base branch (`worktrees.base_ref`),
 * and the host-known service context from the manifest — READ-ONLY, never AI
 * output. `repo` stays the repoPath exactly as the gates recorded it, so the
 * observation's attribution matches every other table's.
 */
function testerTargets(
  manifest: Manifest | undefined,
  targets: readonly UatTarget[],
  worktrees: readonly { repo: string; baseRef: string | null }[],
): TesterTarget[] {
  const baseRefByRepo = new Map(worktrees.map((w) => [w.repo, w.baseRef]));
  return targets.map((t) => ({
    repo: t.repo,
    worktreePath: t.path,
    baseRef: baseRefByRepo.get(t.repo) ?? null,
    service:
      manifest === undefined
        ? undefined
        : { start: serviceStartFor(manifest, t.names) },
  }));
}

/** The first manifest-declared service start among a target's repository names. */
function serviceStartFor(manifest: Manifest, names: readonly string[]): string | undefined {
  for (const name of names) {
    const start = manifest.repositories[name]?.service?.start;
    if (start !== undefined) return start;
  }
  return undefined;
}
