import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/db.js';
import type { StageRunResult } from '../../model/types.js';
import type { Manifest, UatConfig } from '../../manifest/types.js';
import type { AgentAdapter } from '../../agent/adapter.js';
import type { HeadlessOutputChunk } from '../../agent/headlessSpawn.js';
import type { ProcessAssignmentSnapshot } from '../../agent/processAssignment.js';
import type { GateRunInput } from '../../store/gateRuns.js';
import { commitGateOutcome, type RunOutcome, type RecoveryTriggerInput } from '../gates/commit.js';
import { openGateRun } from '../gates/evidence.js';
import { nowIso } from '../../model/time.js';
import { summarizeGateFailure } from '../../model/gateSummary.js';
import { listWorktreesByTicket } from '../../store/dashboard.js';
import { listGateRuns } from '../../store/gateRuns.js';
import { listProcessRuns, setProcessRunResultKind } from '../../store/processRuns.js';
import { defaultGitRunner, type GitRunner } from '../../integrations/git.js';
import { probeScripts, type ScriptProbe } from '../gates/probe.js';
import { resolveGates, type GateResolution, type ResolvedGate } from '../gates/resolve.js';
import { partitionDisabled, type StageGateResolution } from '../gates/disable.js';
import { runGateList } from '../gates/runList.js';
import { checkNodeDeps, type NodeDepsCheck } from '../gates/depsCheck.js';
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
}

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
  let unavailable: Extract<GateResolution, { kind: 'unavailable' }> | null = null;

  for (const name of keys) {
    const resolved = resolveGates(probe, declaredGatesFor(config, name), PROBE_SCRIPTS, debug);
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

  const { kept, skipped } = partitionDisabled([...byIdentity.values()], disabledNames, debug);
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
        summary:
          entry.result.exitCode !== null && entry.result.exitCode !== 0
            ? summarizeGateFailure(entry.result.output)
            : null,
      })),
    );
  };

  const planned = opts.manifest
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

  for (const target of targets) {
    const label = target.names.join(', ') || target.repo;
    const scriptProbe = probe(target.path, opts.debug);
    const resolution = resolveTargetGates(scriptProbe, opts.manifest?.uat, target.names, disabledNames, opts.debug);

    // Environmental: karst could not ask this repository anything. Park rather
    // than reduce — a block is not a verdict about the ticket's code. Earlier
    // targets already ran, so their rows go down with the park.
    if (resolution.kind === 'unavailable') {
      const reason = `${label}: ${resolution.reason}`;
      opts.debug?.(
        `[gate] uat ticket ${opts.ticketId}: target ${label} unavailable ` +
          `(${resolution.blocker}: ${resolution.reason})`,
      );
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

    // A dependency tree that drifted from the lockfile is a SETUP failure, not
    // a code verdict: every gate in a resolve-up worktree fails identically at
    // once, which reads as a pre-existing repo regression. Park (no attempt
    // consumed) and name the repair instead of attributing it to the ticket.
    if (resolution.gates.some((g) => g.script !== null)) {
      const depsCheck = await checkDeps(target.path, { signal: opts.signal, onDebug: opts.debug });
      if (!depsCheck.ok) {
        const reason =
          depsCheck.kind === 'dependency-drift'
            ? `${label}: installed dependencies are inconsistent with package-lock.json — ` +
              `${depsCheck.reason} — run 'npm install' (or 'npm ci') in ${target.path}`
            : `${label}: could not verify installed dependencies — ${depsCheck.reason}`;
        opts.debug?.(
          `[gate] uat ticket ${opts.ticketId}: target ${label} ${depsCheck.kind} (${depsCheck.reason})`,
        );
        return finish({ kind: 'blocked', blocker: 'capability-missing', reason }, [reason]);
      }
    }

    const scripts = scriptProbe.kind === 'ok' ? scriptProbe.scripts : {};
    opts.debug?.(
      `[gate] uat ticket ${opts.ticketId}: target ${label} — ${resolution.gates.length} gate(s)` +
        (resolution.skipped.length > 0 ? `, ${resolution.skipped.length} disabled` : ''),
    );
    const run = await runGates(resolution.gates, target.path, {
      signal: opts.signal,
      now,
      scriptsAvailable: (script) => scripts[script] !== undefined,
      onGateStart: opts.onGateStart,
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
  let testerResult: TesterRunResult | null = null;
  if (deps.tester) {
    testerResult = await runUatTester(
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
        debug: opts.debug,
        git,
        // The gates that actually RAN and passed (a null exit code is "no such
        // script", not a pass). Named in the prompt so the Tester does not
        // re-run the deterministic half the stage just finished.
        gatesPassed: entries
          .filter((entry) => entry.result.exitCode === 0)
          .map((entry) => entry.result.name),
        onOutput: opts.onTesterOutput,
        onTargetProgress: opts.onTesterTargetProgress,
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
  worktrees: readonly { repo: string; baseRef: string | null; branch: string | null }[],
): TesterTarget[] {
  const baseRefByRepo = new Map(worktrees.map((w) => [w.repo, w.baseRef]));
  const branchByRepo = new Map(worktrees.map((w) => [w.repo, w.branch]));
  return targets.map((t) => ({
    repo: t.repo,
    worktreePath: t.path,
    baseRef: baseRefByRepo.get(t.repo) ?? null,
    branch: branchByRepo.get(t.repo) ?? null,
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
