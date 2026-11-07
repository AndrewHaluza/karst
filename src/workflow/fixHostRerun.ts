import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { activeFixRound } from '../store/recoveryRounds.js';
import { listGateRuns, type GateRun } from '../store/gateRuns.js';
import { finishProcessRun } from '../store/processRuns.js';
import { roundById } from '../store/recoveryRounds.js';
import { claimHostRerun, closeRoundPassed, parkRoundOutOfFixing } from '../store/hostRerunRound.js';
import { parkFixStage } from '../store/recoveryRoundsWrite.js';
import { setStage } from '../store/stages.js';
import { setAgentState, setStageCurrent } from '../store/tickets.js';
import { nowIso } from '../model/time.js';
import { regenerateRepoOf } from './gates/regenerate.js';

/** Why a fix round closed when the host's re-run found the failed gates green. */
export const HOST_RERUN_PASSED_REASON = 'no change: failed gates passed on re-run';

/** `result_kind` on the fix process run the host closed (not the agent's marker). */
export const HOST_RERUN_RESULT_KIND = 'host-rerun-passed';

/** A gate that failed in the source stage's latest run, with the invocation to repeat. */
export interface FailedGate {
  gateName: string;
  repo: string | null;
  command: string;
  args: string[];
  /**
   * `regenerate`: a composite gate. Its stored `command` is a display label, not an argv, so
   * the re-run goes through the gate's own runner (the manifest `ship.regenerate` spec).
   */
  kind: 'command' | 'regenerate';
}

/** One re-run gate's answer: `exitCode` null means it could not give one. */
export interface GateRerunResult {
  exitCode: number | null;
  summary: string | null;
  /** True when the host has no way to run this gate again: it is not a failing gate. */
  cannotRerun?: true;
}

export interface HostRerunDeps {
  /** Run one failed gate again (sandbox- and host-gate-aware, bound by the host). */
  runGate: (ticketId: number, gate: FailedGate) => Promise<GateRerunResult>;
  now?: () => string;
}

/** The one-sentence way out, named in the marker reply and the park verdict. */
export const HOST_RERUN_WAY_OUT =
  'a code change from this session cannot fix this failure — stop the session; the user resets the stage (Reset stage) or fixes the environment and retries the gate';

export interface RerunFailure {
  gateName: string;
  summary: string;
  /** The gate could not be re-run on the host; it did not fail again. */
  cannotRerun?: true;
}

/** One sentence per outcome kind: gates that fail again, then gates the host cannot re-run. */
function describeFailures(failures: RerunFailure[]): string {
  const failing = failures.filter((f) => !f.cannotRerun).map((f) => `${f.gateName}: ${f.summary}`);
  const skipped = failures.filter((f) => f.cannotRerun).map((f) => `${f.gateName} (${f.summary})`);
  return [
    ...(failing.length > 0 ? [`still fails — ${failing.join('; ')}`] : []),
    ...(skipped.length > 0 ? [`cannot be re-run on the host: ${skipped.join('; ')}`] : []),
  ].join('; ');
}

export type HostRerunOutcome =
  | { kind: 'not-applicable' }
  | { kind: 'already-used' }
  | { kind: 'passed'; stage: StageKey }
  | { kind: 'failed'; failures: RerunFailure[] };

/** What the marker reply tells the agent about the path taken. */
export interface HostRerunReply {
  ok: boolean;
  message: string;
}

/** The gates of the source stage's LATEST batch that ran and exited non-zero. */
function failedGatesOf(runs: GateRun[], stage: StageKey): FailedGate[] {
  const own = runs.filter((r) => r.stageKey === stage && r.command !== null);
  const latest = own.reduce((max, r) => (r.runAt > max ? r.runAt : max), '');
  return own
    .filter((r) => r.runAt === latest && !r.skipped && r.exitCode !== null && r.exitCode !== 0)
    .map((r) => ({
      gateName: r.gateName,
      repo: r.repo,
      command: r.command as string,
      args: r.args ?? [],
      kind: regenerateRepoOf(r.gateName) !== null ? ('regenerate' as const) : ('command' as const),
    }));
}

async function rerunOne(deps: HostRerunDeps, ticketId: number, gate: FailedGate): Promise<RerunFailure | null> {
  try {
    const res = await deps.runGate(ticketId, gate);
    if (res.exitCode === 0) return null;
    const summary = res.summary ?? (res.exitCode === null ? 'the gate could not run' : `exit ${res.exitCode}`);
    return { gateName: gate.gateName, summary, ...(res.cannotRerun ? { cannotRerun: true as const } : {}) };
  } catch (err) {
    return { gateName: gate.gateName, summary: `re-run error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Return the ticket to the source stage and close the round, atomically. */
function returnToSource(store: Store, ticketId: number, roundId: number, stage: StageKey, at: string): void {
  const cleared = { verdict: null, endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null } as const;
  store.db.transaction(() => {
    const fixRunId = roundById(store, roundId)?.fixProcessRunId ?? null;
    if (fixRunId !== null) finishProcessRun(store, fixRunId, 'interrupted', at, HOST_RERUN_RESULT_KIND, null, HOST_RERUN_PASSED_REASON);
    setStage(store, ticketId, stage, { status: 'running', startedAt: at, ...cleared });
    setStage(store, ticketId, 'fix', { status: 'pending', startedAt: null, attempt: 0, artifactPath: null, ...cleared });
    closeRoundPassed(store, roundId, HOST_RERUN_PASSED_REASON, at);
    setStageCurrent(store, ticketId, stage);
    setAgentState(store, ticketId, 'idle');
  })();
}

/** Park the fix stage and move the round out of `fixing`, in one transaction. */
function parkRound(store: Store, ticketId: number, roundId: number, verdict: string, at: string): void {
  store.db.transaction(() => {
    parkFixStage(store, ticketId, verdict, at);
    parkRoundOutOfFixing(store, roundId, verdict, at);
  })();
}

/**
 * A `stage fix pass` marker was refused for "no new commit": re-run ONLY the
 * source stage's failed gates, once per fix round. All green closes the round
 * `passed` and returns the ticket to the source stage; any red leaves the
 * refusal standing and parks the fix stage (Needs you) with the failures.
 * Never an agent override — the host decides from gate exit codes.
 */
export async function hostRerunFailedGates(store: Store, ticketId: number, deps: HostRerunDeps): Promise<HostRerunOutcome> {
  const round = activeFixRound(store, ticketId);
  if (round === null || round.triggerKind !== 'gate-failure') return { kind: 'not-applicable' };
  const failed = failedGatesOf(listGateRuns(store, ticketId), round.sourceStage);
  if (failed.length === 0) return { kind: 'not-applicable' };
  const now = deps.now ?? nowIso;
  if (!claimHostRerun(store, round.id, now())) {
    parkRound(store, ticketId, round.id, `no new commit, and the host already re-ran the failed gates — ${HOST_RERUN_WAY_OUT}`, now());
    return { kind: 'already-used' };
  }

  const results = await Promise.all(failed.map((g) => rerunOne(deps, ticketId, g)));
  const failures = results.filter((r): r is RerunFailure => r !== null);
  if (failures.length === 0) {
    returnToSource(store, ticketId, round.id, round.sourceStage, now());
    return { kind: 'passed', stage: round.sourceStage };
  }
  const detail = describeFailures(failures);
  parkRound(store, ticketId, round.id, `no new commit, and the host re-run did not close the round — ${detail}. ${HOST_RERUN_WAY_OUT}`, now());
  return { kind: 'failed', failures };
}

/** The marker-reply wording for an outcome; undefined when the host did nothing. */
export function describeHostRerun(outcome: HostRerunOutcome): HostRerunReply | undefined {
  switch (outcome.kind) {
    case 'not-applicable':
      return undefined;
    case 'passed':
      return { ok: true, message: `${HOST_RERUN_PASSED_REASON} — the ticket returned to ${outcome.stage}` };
    case 'already-used':
      return { ok: false, message: `the host already re-ran the failed gates once this fix round — the refusal stands — ${HOST_RERUN_WAY_OUT}` };
    case 'failed': {
      return { ok: false, message: `the host re-ran the failed gates — the refusal stands (${describeFailures(outcome.failures)}). ${HOST_RERUN_WAY_OUT}` };
    }
  }
}
