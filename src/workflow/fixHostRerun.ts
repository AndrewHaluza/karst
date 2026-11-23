import type { Store } from '../store/db.js';
import type { StageKey } from '../model/types.js';
import { activeFixRound, type RecoveryRound } from '../store/recoveryRounds.js';
import { listGateRuns, type GateRun } from '../store/gateRuns.js';
import { finishProcessRun } from '../store/processRuns.js';
import { roundById } from '../store/recoveryRounds.js';
import { claimNoChangeRerun, previousContinuedRound, previousNoChangeRound } from '../store/fixNoChangeRounds.js';
import { listFixRoundHeads, sameHeads } from '../store/fixRoundHeads.js';
import { noChangeEndReason } from '../model/noChange.js';
import { claimHostRerun, closeRoundPassed, hostRerunPassedBefore, markHostRerunFailed } from '../store/hostRerunRound.js';
import { setStage } from '../store/stages.js';
import { setAgentState, setStageCurrent } from '../store/tickets.js';
import { nowIso } from '../model/time.js';
import { regenerateRepoOf } from './gates/regenerate.js';
import { signatureOfSummary } from './gates/environmentSignature.js';
import { parkRound, continueOrPark } from './fixContinue.js';

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
  /**
   * Run the failed gates of the source stage again, one result for each gate in the same order.
   * The host binds it to `runGateList`, one call for each repo worktree (sandbox- and host-gate-aware).
   * A throw fails every gate of the set.
   */
  runGates: (ticketId: number, gates: readonly FailedGate[], stage: StageKey) => Promise<GateRerunResult[]>;
  now?: () => string;
  /**
   * Runs after a passing re-run returned the ticket to its source stage: the host re-drives the
   * stage and records the gate pass. A throw is sent to `debug`, never fatal.
   */
  onPassed?: (ticketId: number, stage: StageKey, roundId: number) => Promise<void> | void;
  /**
   * Runs after the host opened the NEXT fix round because the failed gates still fail (T1330): the
   * host drives the ticket with the `fix-continued` resume trigger. A throw is sent to `debug`.
   */
  onNextRound?: (ticketId: number) => void;
  debug?: (message: string) => void;
}

/** The one-sentence way out, named in the marker reply and the park verdict. */
export const HOST_RERUN_WAY_OUT =
  'a code change from this session cannot fix this failure — stop the session; the user fixes the environment and clicks Retry gate, or clicks Accept and continue';

/** Leading text of the park verdict when this round already used its one host re-run. */
export const PARK_NO_NEW_COMMIT_ALREADY_RERAN = 'no new commit, and the host already re-ran the failed gates';

/** Leading text of the park verdict when the host re-run of a no-new-commit round still failed. */
export const PARK_NO_NEW_COMMIT_RERUN_FAILED = 'no new commit, and the host re-run did not close the round';

/** Leading text of the park verdict when the host re-run of a no-change round still failed. */
export const PARK_NO_CHANGE_RERUN_FAILED =
  'the agent found no change to make, and the re-run of the failed gates did not close the round';

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
  | { kind: 'next-round'; round: number; maxRounds: number; failures: RerunFailure[] }
  | { kind: 'failed'; failures: RerunFailure[] };

/** What the marker reply tells the agent about the path taken. */
export interface HostRerunReply {
  ok: boolean;
  message: string;
}

/** The gates of the source stage's LATEST batch that ran and exited non-zero. */
function failedRowsOf(runs: GateRun[], stage: StageKey): GateRun[] {
  const own = runs.filter((r) => r.stageKey === stage && r.command !== null);
  const latest = own.reduce((max, r) => (r.runAt > max ? r.runAt : max), '');
  return own.filter((r) => r.runAt === latest && !r.skipped && r.exitCode !== null && r.exitCode !== 0);
}

export function failedGatesOf(runs: GateRun[], stage: StageKey): FailedGate[] {
  return failedRowsOf(runs, stage)
    .map((r) => ({
      gateName: r.gateName,
      repo: r.repo,
      command: r.command as string,
      args: r.args ?? [],
      // A composite row stores its own label as the command and has no argv.
      kind: regenerateRepoOf(r.gateName) !== null && r.command === r.gateName && (r.args ?? []).length === 0 ? ('regenerate' as const) : ('command' as const),
    }));
}

function failureOf(gate: FailedGate, res: GateRerunResult | undefined): RerunFailure | null {
  if (res === undefined) return { gateName: gate.gateName, summary: 'the gate could not run' };
  if (res.exitCode === 0) return null;
  const summary = res.summary ?? (res.exitCode === null ? 'the gate could not run' : `exit ${res.exitCode}`);
  return { gateName: gate.gateName, summary, ...(res.cannotRerun ? { cannotRerun: true as const } : {}) };
}

/** Run the set once; a throw fails every gate of it, never the round's bookkeeping. */
async function rerunAll(deps: HostRerunDeps, ticketId: number, gates: readonly FailedGate[], stage: StageKey): Promise<RerunFailure[]> {
  try {
    const results = await deps.runGates(ticketId, gates, stage);
    return gates.flatMap((g, i) => failureOf(g, results[i]) ?? []);
  } catch (err) {
    const summary = `re-run error: ${err instanceof Error ? err.message : String(err)}`;
    return gates.map((g) => ({ gateName: g.gateName, summary }));
  }
}

/** Return the ticket to the source stage and close the round, atomically. */
function returnToSource(store: Store, ticketId: number, roundId: number, stage: StageKey, reason: string, at: string): void {
  const cleared = { verdict: null, endedAt: null, blockedKind: null, blockedReason: null, blockedAt: null } as const;
  store.db.transaction(() => {
    const fixRunId = roundById(store, roundId)?.fixProcessRunId ?? null;
    if (fixRunId !== null) finishProcessRun(store, fixRunId, 'interrupted', at, HOST_RERUN_RESULT_KIND, null, reason);
    setStage(store, ticketId, stage, { status: 'running', startedAt: at, ...cleared });
    setStage(store, ticketId, 'fix', { status: 'pending', startedAt: null, attempt: 0, artifactPath: null, ...cleared });
    closeRoundPassed(store, roundId, reason, at);
    setStageCurrent(store, ticketId, stage);
    setAgentState(store, ticketId, 'idle');
  })();
}

/** Tell the host a re-run passed; a throw is logged, because the round is already closed. */
async function notifyPassed(deps: HostRerunDeps, ticketId: number, stage: StageKey, roundId: number): Promise<void> {
  try {
    await deps.onPassed?.(ticketId, stage, roundId);
  } catch (err) {
    deps.debug?.(`[fix-rerun] ticket ${ticketId}: after a passed re-run: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Round ids with a re-run in flight in THIS process (T1330). A duplicate marker must never open a
 * second round or park the first, so a call that finds its round here writes nothing. Per-process
 * by design: a claim already used and not in flight is handled by the store.
 */
const inFlightReruns = new Set<number>();

/** The stored summaries of the failed rows, as failures the next-round text can name. */
function storedFailures(rows: readonly GateRun[]): RerunFailure[] {
  return rows.map((r) => ({ gateName: r.gateName, summary: r.summary ?? `exit ${r.exitCode}` }));
}

/** The existing host-park lead for the marker kind that closed this round. */
function markerLead(round: RecoveryRound): string {
  return round.noChangeReason !== null ? PARK_NO_CHANGE_RERUN_FAILED : PARK_NO_NEW_COMMIT_RERUN_FAILED;
}

/** Tell the host the next round opened; a throw is logged, because the round is already open. */
function notifyNextRound(deps: HostRerunDeps, ticketId: number): void {
  try {
    deps.onNextRound?.(ticketId);
  } catch (err) {
    deps.debug?.(`[fix-rerun] ticket ${ticketId}: after a continued round: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function nextRoundOutcome(
  round: RecoveryRound,
  failures: RerunFailure[],
  deps: HostRerunDeps,
  ticketId: number,
): HostRerunOutcome {
  notifyNextRound(deps, ticketId);
  return { kind: 'next-round', round: round.round, maxRounds: round.maxRounds, failures };
}

/**
 * True when this round sits on the head an earlier round already failed on: the round just before
 * it was continued (`FIX_CONTINUED_PREFIX`) with equal HEADs, or the round has a no-change reason
 * and the previous no-change round had equal HEADs. The host then skips the gate run.
 */
function sameHeadAsEarlier(store: Store, round: RecoveryRound): boolean {
  const own = listFixRoundHeads(store, round.id);
  const continued = previousContinuedRound(store, round.ticketId);
  if (continued !== null && sameHeads(listFixRoundHeads(store, continued.round.id), own)) return true;
  if (round.noChangeReason === null) return false;
  const previous = previousNoChangeRound(store, round.ticketId, round.sourceStage, round.id);
  return previous !== null && sameHeads(listFixRoundHeads(store, previous.id), own);
}

/**
 * A `stage fix pass` marker was refused for "no new commit", or a no-change marker asked the host
 * to check the failed gates. Re-run ONLY the source stage's failed gates, once per fix round. All
 * green closes the round `passed` and returns the ticket to the source stage. A red gate no longer
 * parks at once (T1330): the host opens the next fix round of the same episode while the committed
 * budget has a round left and the head has changed within the loop limit; it parks only when the
 * rounds are spent, the same head failed FIX_SAME_HEAD_LIMIT times, or the host cannot re-run the
 * gate at all. A head an earlier round already failed on is not gated again. Never an agent
 * override — the host decides from gate exit codes.
 */
export async function hostRerunFailedGates(
  store: Store,
  ticketId: number,
  deps: HostRerunDeps,
  options: { parkOnFailure?: boolean } = {},
): Promise<HostRerunOutcome> {
  const park = options.parkOnFailure !== false;
  const round = activeFixRound(store, ticketId);
  if (round === null || round.triggerKind !== 'gate-failure') return { kind: 'not-applicable' };
  const runs = listGateRuns(store, ticketId);
  const failedRows = failedRowsOf(runs, round.sourceStage);
  const failed = failedGatesOf(runs, round.sourceStage);
  if (failed.length === 0) return { kind: 'not-applicable' };
  // A duplicate marker for a round whose re-run is in flight writes nothing at all.
  if (inFlightReruns.has(round.id)) return { kind: 'already-used' };

  const now = deps.now ?? nowIso;
  const claimed = round.noChangeReason !== null ? claimNoChangeRerun(store, round.id, now()) : claimHostRerun(store, round.id, now());
  if (!claimed) {
    if (!park) return { kind: 'already-used' };
    // The claim is spent and nothing is in flight: decide from the stored evidence, run no gate.
    const failures = storedFailures(failedRows);
    const decision = continueOrPark(store, round, {
      detail: describeFailures(failures),
      parkVerdict: PARK_NO_NEW_COMMIT_ALREADY_RERAN,
      at: now(),
    });
    if (decision.kind === 'parked') return { kind: 'already-used' };
    return nextRoundOutcome(decision.round, failures, deps, ticketId);
  }

  // Same head as an earlier round the host already continued: skip the gate. The exception is a
  // round whose EVERY failed row carries an environment signature — such a fault can pass later.
  if (!failedRows.every((r) => signatureOfSummary(r.summary) !== null) && sameHeadAsEarlier(store, round)) {
    const failures = storedFailures(failedRows);
    if (!park) {
      markHostRerunFailed(store, round.id, `the host re-run failed — ${describeFailures(failures)}`);
      return { kind: 'failed', failures };
    }
    const decision = continueOrPark(store, round, {
      detail: describeFailures(failures),
      parkVerdict: markerLead(round),
      at: now(),
    });
    if (decision.kind === 'parked') return { kind: 'failed', failures };
    return nextRoundOutcome(decision.round, failures, deps, ticketId);
  }

  inFlightReruns.add(round.id);
  let failures: RerunFailure[];
  try {
    failures = await rerunAll(deps, ticketId, failed, round.sourceStage);
  } finally {
    inFlightReruns.delete(round.id);
  }

  if (failures.length === 0) {
    const closeReason = round.noChangeReason !== null ? noChangeEndReason(round.noChangeReason) : HOST_RERUN_PASSED_REASON;
    returnToSource(store, ticketId, round.id, round.sourceStage, closeReason, now());
    await notifyPassed(deps, ticketId, round.sourceStage, round.id);
    return { kind: 'passed', stage: round.sourceStage };
  }
  const detail = describeFailures(failures);
  // A gate the host cannot run again can never be verified here: park at once, as today.
  if (failures.every((f) => f.cannotRerun === true)) {
    if (!park) {
      markHostRerunFailed(store, round.id, `the host re-run failed — ${detail}`);
      return { kind: 'failed', failures };
    }
    parkRound(store, ticketId, round.id, `${markerLead(round)} — ${detail}. ${HOST_RERUN_WAY_OUT}`, now());
    return { kind: 'failed', failures };
  }
  if (!park) {
    // The round stays open for the agent's brief; the re-run is over, so the in-flight reading ends.
    markHostRerunFailed(store, round.id, `the host re-run failed — ${detail}`);
    return { kind: 'failed', failures };
  }
  const decision = continueOrPark(store, round, { detail, parkVerdict: markerLead(round), at: now() });
  if (decision.kind === 'parked') return { kind: 'failed', failures };
  return nextRoundOutcome(decision.round, failures, deps, ticketId);
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
    case 'next-round':
      return {
        ok: false,
        message: `the failed gates still fail — ${describeFailures(outcome.failures)}; fix round ${outcome.round} of ${outcome.maxRounds} opens now; stop this turn, the new brief follows`,
      };
    case 'failed': {
      return { ok: false, message: `the host re-ran the failed gates — the refusal stands (${describeFailures(outcome.failures)}). ${HOST_RERUN_WAY_OUT}` };
    }
  }
}

/**
 * The pre-brief re-run: a gate-failure round just opened, and EVERY failed gate carries an
 * environment signature (`gates/environmentSignature.ts`). Run the one host re-run of the round
 * before the fix brief is armed. All green closes the round with `HOST_RERUN_PASSED_REASON` and
 * returns the ticket to the source stage — no brief. Any red leaves the round as it is, so the
 * brief is armed as today (it already carries the signature line) and the stamp keeps this to once.
 * It closes at most one round for each ticket and source stage: a repeat failure goes to the agent.
 * A failure with no signature, or a mixed round, is `not-applicable`: a real defect goes to the agent.
 */
export async function preBriefHostRerun(store: Store, ticketId: number, deps: HostRerunDeps): Promise<HostRerunOutcome> {
  const round = activeFixRound(store, ticketId);
  if (round === null || round.triggerKind !== 'gate-failure') return { kind: 'not-applicable' };
  // Bound a repeating environment failure: one pre-brief close for each ticket and source stage,
  // then the next failure goes to the agent (a close returns the ticket to the stage with a fresh budget).
  if (hostRerunPassedBefore(store, ticketId, round.sourceStage, HOST_RERUN_PASSED_REASON, round.id)) return { kind: 'not-applicable' };
  const runs = listGateRuns(store, ticketId);
  const failed = failedGatesOf(runs, round.sourceStage);
  if (failed.length === 0) return { kind: 'not-applicable' };
  const failedRows = failedRowsOf(runs, round.sourceStage);
  if (!failedRows.every((r) => signatureOfSummary(r.summary) !== null)) return { kind: 'not-applicable' };
  return hostRerunFailedGates(store, ticketId, deps, { parkOnFailure: false });
}

/** Run the injected pre-brief re-run after a failed verdict committed. A throw is logged, never fatal: the brief then arms as today. */
export async function runPreBriefRerun(
  rerun: ((ticketId: number) => Promise<HostRerunOutcome>) | undefined,
  ticketId: number,
  debug?: (message: string) => void,
): Promise<void> {
  if (rerun === undefined) return;
  try {
    const outcome = await rerun(ticketId);
    debug?.(`[gate] ticket ${ticketId}: pre-brief host re-run ${outcome.kind}`);
  } catch (err) {
    debug?.(`[gate] ticket ${ticketId}: pre-brief host re-run threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
