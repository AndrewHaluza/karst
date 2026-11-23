import { deliverToPr, type DeliverDeps } from './deliverToPrOps.js';
import type { DeliverPr } from '../../workflow/deliverState.js';
import type { GitResult } from './deliverToPrOps.js';
import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { getMergeCheck } from '../../store/mergeChecks.js';
import { clearConflictRound } from '../../store/autopilot.js';
import { shortSha } from '../../model/inside/deliver.js';
import type { FailedShipGate, ShipGateReport } from './shipGatesOps.js';
import { environmentSignature, signatureOfSummary } from '../../workflow/gates/environmentSignature.js';

/**
 * Auto-delivery of a resolved merge conflict at ship (arch:AC-39, D247).
 *
 * "Resolve conflicts" at ship hands the agent a brief that ends "Commit the
 * merge. Do not push." Karst delivers: when that session next goes idle, the
 * existing Deliver to PR path syncs, the merged tree is verified and gated, and
 * only then does ship's push land it on the open PR. The agent never pushes
 * (it bypassed the gates, T765), and only a session OPENED by Resolve conflicts
 * is armed, so a manual fix session keeps its manual Deliver button (FIX-46).
 */

/** The conflict round a Resolve-conflicts click armed: what "resolved" is measured against. */
export interface ResolvedRound {
  readonly repo: string;
  /** merge_checks.baseSha at click time: the branch must contain it once resolved. */
  readonly baseSha: string | null;
  /** The conflicted files; they are scanned for leftover markers. */
  readonly files: readonly string[];
}

/**
 * Why a delivery of a VERIFIED merge was refused: the merge passed `verifyMergeResolved`, so only a gate or the base
 * check stopped it. The park names it instead of waiting for a Stop that never comes (@arch:AP-01, T1315).
 */
export interface RoundRefusal {
  readonly repo: string;
  /** The tail of the park reason: `gate "unit" failed`, `the base check failed`. */
  readonly tail: string;
  /** The merge commit that is ready in the worktree, or null when git could not read it. */
  readonly sha: string | null;
}

export interface ConflictRounds {
  arm(ticketId: number, round: ResolvedRound): void;
  armed(ticketId: number): ResolvedRound | null;
  /** When the round was armed (ms), or null. */
  armedAt(ticketId: number): number | null;
  /** When the last auto-deliver of the round ended (ms), or null when none ran since the round armed (T1315). */
  deliveredAt(ticketId: number): number | null;
  /** The auto-deliver of the round ended: the stall clock counts from here, not from the receipt. */
  markDelivered(ticketId: number): void;
  /** Why the last auto-deliver refused a verified merge, or null (T1315). */
  refusal(ticketId: number): RoundRefusal | null;
  refuse(ticketId: number, refusal: RoundRefusal): void;
  disarm(ticketId: number): void;
}

/**
 * In memory on purpose: a reload loses the session too, and the manual Deliver button remains. `onDisarm` lets the store
 * forget the round's slot (T996) when the round ends: delivered, dropped, stopped.
 */
export function createConflictRounds(onDisarm?: (ticketId: number) => void): ConflictRounds {
  const byTicket = new Map<number, ResolvedRound>();
  const since = new Map<number, number>();
  const delivered = new Map<number, number>();
  const refusals = new Map<number, RoundRefusal>();
  return {
    arm: (ticketId, round) => {
      byTicket.set(ticketId, round);
      const now = Date.now();
      since.set(ticketId, now);
      delivered.delete(ticketId);
      refusals.delete(ticketId);
    },
    armedAt: (ticketId) => since.get(ticketId) ?? null,
    armed: (ticketId) => byTicket.get(ticketId) ?? null,
    deliveredAt: (ticketId) => delivered.get(ticketId) ?? null,
    markDelivered: (ticketId) => { delivered.set(ticketId, Date.now()); },
    refusal: (ticketId) => refusals.get(ticketId) ?? null,
    refuse: (ticketId, refusal) => { refusals.set(ticketId, refusal); },
    disarm: (ticketId) => {
      byTicket.delete(ticketId);
      since.delete(ticketId);
      delivered.delete(ticketId);
      refusals.delete(ticketId);
      onDisarm?.(ticketId);
    },
  };
}

type Git = (cwd: string, args: readonly string[]) => Promise<GitResult>;

/** The reason a taken-over auto-deliver gives to refuse its own push; never shown as an error. */
const TAKEN_OVER = 'a manual Deliver took over';

const MARKER_RE = '^(<<<<<<< |>>>>>>> )';

/** Null when the merge in `cwd` is finished; else why it is not. */
export async function verifyMergeResolved(git: Git, cwd: string, round: ResolvedRound): Promise<string | null> {
  if (round.baseSha !== null && (await git(cwd, ['merge-base', '--is-ancestor', round.baseSha, 'HEAD'])).code !== 0) {
    return `the branch does not contain the base head ${round.baseSha.slice(0, 9)} yet`;
  }
  const status = await git(cwd, ['status', '--porcelain']);
  if (status.code !== 0) return 'could not read the worktree status';
  if (status.stdout.trim() !== '') return 'the worktree has uncommitted changes';
  if (round.files.length > 0) {
    const markers = await git(cwd, ['grep', '-lE', MARKER_RE, 'HEAD', '--', ...round.files]);
    if (markers.code !== 0 && markers.code !== 1) return 'could not scan the resolved files for conflict markers';
    if (markers.code === 0 && markers.stdout.trim() !== '') {
      return `conflict markers remain in ${markers.stdout.trim().split('\n').map((l) => l.replace(/^HEAD:/, '')).join(', ')}`;
    }
  }
  return null;
}

export interface AutoDeliverDeps extends Omit<DeliverDeps, 'verify'> {
  readonly ticketId: number;
  /** Ticket label for the log line. */
  readonly key: string;
  readonly rounds: ConflictRounds;
  /** Null when the merge is finished and the ship-stage gates pass on it; else the reason. */
  readonly verifyMerge: (pr: DeliverPr, round: ResolvedRound) => Promise<string | null>;
  /** `signal` aborts the running gate process when a manual Deliver takes over (T1018). */
  readonly runGates: (prs: readonly DeliverPr[], signal: AbortSignal, only?: readonly string[]) => Promise<ShipGateReport>;
  /** The merged HEAD sha of a PR's worktree: the merge commit a refusal names (@arch:AP-01). Absent → no sha in the park. */
  readonly mergeSha?: (pr: DeliverPr) => Promise<string | null>;
  /**
   * Runs after the ship gates pass: the branch merged with the moved base, as CI tests it (D541, `baseMovedCheck.ts`).
   * Null = nothing to stop the push (base unchanged, merge passed, or not checkable); else the reason, shown as a ship
   * gate failure. `signal` aborts it when a manual Deliver takes over. Absent → no check.
   */
  readonly checkBase?: (pr: DeliverPr, signal: AbortSignal) => Promise<string | null>;
  /** The dashboard's transient "Delivering resolved merge to PR #n…" line. */
  readonly status: (message: string) => void;
  /** The INFO log line (not the user toast). */
  readonly log: (message: string) => void;
}

interface InFlight {
  readonly controller: AbortController;
  /** `gates`: a takeover may still stop it. `pushing`: the push has begun and a takeover would double it. */
  phase: 'gates' | 'pushing';
  takenOver: boolean;
}
const inFlight = new Map<number, InFlight>();

/** Where the in-flight auto-deliver of this ticket is, or null when none runs. */
export function autoDeliverPhase(ticketId: number): 'gates' | 'pushing' | null {
  return inFlight.get(ticketId)?.phase ?? null;
}

/** What `takeOverAutoDeliver` did: `none` = no auto-deliver runs; `pushing` = it already pushes, so the manual push must wait. */
export type TakeOverResult = 'none' | 'taken-over' | 'pushing';

export interface TakeOverDeps {
  readonly rounds: ConflictRounds;
  readonly key: string;
  /** Marks the stored run `taken-over`; the failed and skipped gates, or null when no run was open. */
  readonly recordTakeOver: () => { readonly failed: readonly string[]; readonly skipped: readonly string[] } | null;
  readonly note: (title: string, body: string) => void;
}

const list = (names: readonly string[]): string => (names.length === 0 ? 'none' : names.join(', '));

/** The bulletin line of a takeover (@arch:AP-00: every action writes a note). */
export function deliverTakeOverNote(t: { readonly failed: readonly string[]; readonly skipped: readonly string[] }): string {
  return `Autopilot: delivery taken over by a manual Deliver; failed: ${list(t.failed)}; skipped: ${list(t.skipped)}`;
}

/**
 * A manual Deliver during the auto-deliver's gates takes over (T1018): stop the gate run, disarm the round, write one
 * note. The caller then pushes through the normal Deliver path; the auto-deliver's verify refuses, so it never pushes.
 */
export function takeOverAutoDeliver(ticketId: number, d: TakeOverDeps): TakeOverResult {
  const entry = inFlight.get(ticketId);
  if (entry === undefined) return 'none';
  if (entry.phase === 'pushing' || entry.takenOver) return entry.takenOver ? 'taken-over' : 'pushing';
  entry.takenOver = true;
  entry.controller.abort();
  d.rounds.disarm(ticketId);
  const facts = d.recordTakeOver() ?? { failed: [], skipped: [] };
  const title = deliverTakeOverNote(facts);
  d.note(title, `${d.key}: ${title.replace(/^Autopilot: /, '')}. The failed gates stay on record on the ship panel.`);
  return 'taken-over';
}

/**
 * The host's drain flag (@arch:DRAIN-01). While it answers true, no auto-deliver and no skipped-gate re-run starts.
 * The armed round stays in memory and in the store, so the resume path of @arch:AP-01 delivers it after the reload.
 */
let drainProbe: (() => boolean) | undefined;
let drainTrack: (<T>(fn: () => Promise<T>) => Promise<T>) | undefined;
/**
 * `track` runs a live auto-deliver or re-run as a tracked drain run: it counts once, and its push is never refused (it
 * starts before the drain, so DRAIN-01 lets it finish).
 */
export function setDeliverDrain(probe: (() => boolean) | undefined, track?: <T>(fn: () => Promise<T>) => Promise<T>): void {
  drainProbe = probe;
  drainTrack = track;
}

const tracked = <T>(fn: () => Promise<T>): Promise<T> => (drainTrack === undefined ? fn() : drainTrack(fn));

/**
 * The tickets with an auto-delivery or a skipped-gate re-run that runs now. The drain counts each one through
 * `Drain.track`, so the host skips the `deliver_runs` rows of these tickets: one live run counts once.
 */
export function liveDeliverTickets(): number[] {
  return [...new Set([...inFlight.keys(), ...reruns.keys()])];
}

/** The auto-deliver of a resolved merge runs now for this ticket (T996: no second conflict round beside it). */
export function isAutoDelivering(ticketId: number): boolean {
  return inFlight.has(ticketId);
}

/** An armed round with no agent and no delivery for this long never delivered (the agent left it unfinished, or a gate failed). */
export const CONFLICT_ROUND_STALL_MS = 5 * 60_000;

/**
 * The stall clock starts at the LATER of the receipt and the end of the last auto-deliver of the round (T1315). The receipt
 * is the agent's `fix-brief --ack` read of the stored conflict brief, or the launch seed (@arch:AP-01); a delivery whose
 * gates ran for 25 minutes must not be dropped the second its push is refused. A round with no receipt is never stalled
 * here: `fixDeliverySweep` re-sends the pointer and raises needs-you, and the round is not dropped.
 * `receiptAt(repo)` is the ISO read time of the latest conflict delivery of the round's repo, or null.
 */
export function isConflictRoundStalled(
  rounds: ConflictRounds,
  ticketId: number,
  receiptAt: (repo: string) => string | null,
  now: number = Date.now(),
): boolean {
  if (isAutoDelivering(ticketId)) return false;
  const round = rounds.armed(ticketId); // null (no round) is never stalled
  if (round === null) return false;
  const receipt = receiptAt(round.repo);
  if (receipt === null) return false;
  const at = Date.parse(receipt);
  const delivered = rounds.deliveredAt(ticketId) ?? Number.NEGATIVE_INFINITY;
  // A receipt that is not a date gives a NaN start, and a NaN comparison is never true: that round is not stalled here.
  return now - Math.max(at, delivered) > CONFLICT_ROUND_STALL_MS;
}

/**
 * The armed round ended on its own (T1287, @arch:AP-01): the stored merge check of its repo names no conflict and the
 * PR head already carries the base head the round resolved. A clean check of a merge that exists only in the worktree is
 * not proof (@arch:GH-03): the PR head must contain `round.baseSha`. An auto-deliver in flight owns the round until it ends.
 */
export interface RoundEndDeps {
  readonly store: Store;
  readonly ticketId: number;
  readonly rounds: ConflictRounds;
  /** The stored head sha of the round repo's OPEN PR, or null when the head is not known. */
  readonly prHead: (repo: string) => string | null;
  /** The worktree of that repo, or null. */
  readonly cwd: (repo: string) => string | null;
  readonly git: Git;
}

export async function conflictRoundEnded(d: RoundEndDeps): Promise<boolean> {
  if (isAutoDelivering(d.ticketId)) return false;
  const round = d.rounds.armed(d.ticketId);
  if (round === null) return false;
  const check = getMergeCheck(d.store, d.ticketId, round.repo);
  if (check !== null && check.state === 'conflicted') return false;
  const head = d.prHead(round.repo);
  if (head === null) return false;
  if (round.baseSha === null) return true;
  const cwd = d.cwd(round.repo);
  if (cwd === null) return false;
  const contained = await d.git(cwd, ['merge-base', '--is-ancestor', round.baseSha, head]);
  return contained.code === 0;
}

/**
 * A push that delivered the merge to the PR ends the armed round (T1287, @arch:AP-01): a manual Deliver after a refused
 * auto-deliver must not leave `conflictRoundActive` true and block every later CI round's round.
 */
export function endConflictRoundOnDeliver(rounds: ConflictRounds, ticketId: number, key: string, log: (message: string) => void): boolean {
  if (rounds.armed(ticketId) === null) return false;
  rounds.disarm(ticketId);
  log(`[ship] ticket ${key}: the conflict round ended, the merge was delivered to the PR`);
  return true;
}

/**
 * The environment reason of every failed gate, or null when one failure needs an agent. A gate that could not run at all
 * (a refused or unresolvable gate) has no exit code and no output, so it is never an environment fault (T1315). An empty
 * list gives an empty list: nothing failed, so there is nothing to re-run.
 */
export function environmentReasons(failed: readonly FailedShipGate[]): string[] | null {
  const reasons: string[] = [];
  for (const gate of failed) {
    const reason = environmentSignature(gate.name, gate.output) ?? signatureOfSummary(gate.summary);
    if (reason === null) return null;
    reasons.push(`${gate.name} (${reason})`);
  }
  return reasons;
}

/** `gate "unit" failed` for a park reason; a plain statement when the run named no gate. */
export function shipGateFailureTail(r: ShipGateReport): string {
  const first = r.failed[0];
  return first === undefined ? 'a ship gate failed' : `gate "${first.name}" failed`;
}

/**
 * The ship gates, then ONE re-run of the failed gates when EVERY failure carried an environment signature (@arch:GATE-ENV-RERUN,
 * T1315). The re-run uses the same signal and take-over rule as the first run. A real failure, a mixed one, or a run whose
 * later repo never gated is never retried: a real failure must never be retried.
 */
async function runShipGatesWithRerun(d: AutoDeliverDeps, prs: readonly DeliverPr[], entry: InFlight): Promise<ShipGateReport> {
  const first = await d.runGates(prs, entry.controller.signal);
  // A manual Deliver got in during the run: it owns the push now, so no second gate run starts behind it.
  if (entry.takenOver) return first;
  const reasons = environmentReasons(first.failed);
  // A pass, or a run that named no failed gate (a refused or unresolvable gate): nothing to re-run.
  if (reasons === null || reasons.length === 0) return first;
  if (first.incomplete === true) {
    d.log(`[ship] ticket ${d.key} auto-deliver: the failed gates are not re-run, a repo after the failing one never gated: ${reasons.join(', ')}`);
    return first;
  }
  d.log(`[ship] ticket ${d.key} auto-deliver: re-running the failed gates once, every failure carried an environment signature: ${reasons.join(', ')}`);
  const repos = new Set(first.failed.map((g) => g.repo));
  return d.runGates(prs.filter((p) => repos.has(p.repo)), entry.controller.signal, first.failed.map((g) => g.name));
}

/** The merge commit a refusal names: absent or unreadable → no sha, never a failing delivery. */
async function mergeShaOf(d: AutoDeliverDeps, pr: DeliverPr): Promise<string | null> {
  if (d.mergeSha === undefined) return null;
  return d.mergeSha(pr).catch(() => null);
}

/** Run on a Stop/session.idle of a ticket; a no-op unless a Resolve-conflicts round is armed for it. */
export async function autoDeliverAfterConflict(d: AutoDeliverDeps): Promise<void> {
  const round = d.rounds.armed(d.ticketId);
  if (round === null || inFlight.has(d.ticketId) || d.agentActive()) return;
  if (drainProbe?.() === true) {
    d.log(`[ship] ticket ${d.key} auto-deliver not started: draining`);
    return;
  }
  const targets = d.targets();
  if (!targets.available) return; // not at ship, no open PR, or a ship run is in flight: the manual button decides
  const entry: InFlight = { controller: new AbortController(), phase: 'gates', takenOver: false };
  inFlight.set(d.ticketId, entry);
  try {
    await tracked(async () => {
    await supersedeRerun(d.ticketId); // the auto-deliver makes a newer head: a re-run on the older head stops and closes first
    const pr = targets.prs.find((p) => p.repo === round.repo) ?? targets.prs[0]!;
    d.status(`Delivering resolved merge to PR #${pr.number ?? '?'}…`);
    const outcome = await deliverToPr({
      ...d,
      verify: async () => {
        const unfinished = await d.verifyMerge(pr, round);
        if (unfinished !== null) {
          d.error(`conflict resolve did not finish: ${unfinished}`);
          return unfinished;
        }
        const gates = await runShipGatesWithRerun(d, targets.prs, entry);
        if (entry.takenOver) return TAKEN_OVER;
        if (gates.reason !== null) {
          d.error(`Resolved merge not delivered: a ship-stage gate failed — ${gates.reason}`);
          // The merge is finished and correct: only a gate stopped the delivery. Name it, so autopilot parks with the gate,
          // the merge commit and the manual Deliver instead of dropping the round as one that never delivered (T1315).
          d.rounds.refuse(d.ticketId, { repo: round.repo, tail: shipGateFailureTail(gates), sha: await mergeShaOf(d, pr) });
          return gates.reason;
        }
        const baseFailure = d.checkBase ? await d.checkBase(pr, entry.controller.signal) : null;
        if (entry.takenOver) return TAKEN_OVER;
        if (baseFailure !== null) {
          d.error(`Resolved merge not delivered: ${baseFailure}`);
          d.rounds.refuse(d.ticketId, { repo: round.repo, tail: 'the base check failed', sha: await mergeShaOf(d, pr) });
          return baseFailure;
        }
        // The gates ran for a while: confirm the tree they checked is still the finished merge.
        const changed = await d.verifyMerge(pr, round);
        // A manual Deliver may have taken over during this check: it pushes, so this run must not.
        if (entry.takenOver) return TAKEN_OVER;
        if (changed !== null) d.error(`conflict resolve did not finish: ${changed}`);
        else entry.phase = 'pushing';
        return changed;
      },
    });
    if (outcome.kind === 'delivered') d.rounds.disarm(d.ticketId);
    d.log(`[ship] ticket ${d.key} auto-deliver after conflict resolve: ${outcome.kind}${'reason' in outcome ? ` (${outcome.reason})` : ''}`);
    });
  } finally {
    // The stall clock counts from here, not from the receipt: a delivery whose gates ran for 25 minutes keeps its round
    // alive for the stall time after the push is refused (T1315).
    d.rounds.markDelivered(d.ticketId);
    inFlight.delete(d.ticketId);
  }
}

/**
 * Arm the round for a Resolve-conflicts click. Only at `ship` (the one stage with
 * no marker to end the session) and only for a recorded conflict; any other click
 * leaves the session's commits to the manual Deliver button.
 */
export function armConflictRound(store: Store, rounds: ConflictRounds, ticketId: number, repo: string): void {
  if (getTicket(store, ticketId).stageCurrent !== 'ship') return;
  const check = getMergeCheck(store, ticketId, repo);
  if (!check || check.state !== 'conflicted') return;
  rounds.arm(ticketId, { repo, baseSha: check.baseSha, files: check.files });
}

/** Resolve-conflicts sessions at ship whose resolved merge Karst delivers on idle (D247). */
let roundEnded: ((ticketId: number) => void) | undefined;
export const conflictRounds = createConflictRounds((ticketId) => roundEnded?.(ticketId));

/** The host sets the store once: a round that ends (delivered, dropped, stopped) frees its sub-task slot. Host tickets only: the engine parks a sandboxed one first. */
export function freeSlotOnConflictRoundEnd(store: Store): void {
  roundEnded = (ticketId) => clearConflictRound(store, ticketId);
}

/**
 * Why the process's armed round of this ticket refused its delivery, or null (`@arch:AP-01`, T1315). It is round state,
 * beside the armed round and its timestamps, so the Autopilot engine reads it the same way it reads the round itself.
 */
export function conflictRoundRefusal(ticketId: number): RoundRefusal | null {
  return conflictRounds.refusal(ticketId);
}

/** The result of the gates a manual Deliver skipped, run on the pushed head. */
export type RerunResult =
  | { readonly kind: 'passed'; readonly headSha: string | null }
  | { readonly kind: 'failed'; readonly headSha: string | null; readonly failed: readonly string[] }
  | { readonly kind: 'stopped'; readonly headSha: string | null };

/** `nothing`: no gate was skipped. `refused`: an agent turn, a push or another re-run blocks it. `superseded`: a newer push aborted it. */
export type RerunOutcome = 'passed' | 'failed' | 'nothing' | 'refused' | 'superseded' | 'stopped';

export interface RerunDeps {
  readonly ticketId: number;
  readonly key: string;
  /** `delivery.takenOver.skipped`: the gates the manual Deliver cut short. */
  readonly skipped: readonly string[];
  readonly agentActive: () => boolean;
  /** Runs exactly these gates in the ticket worktree and records the run (kind `after-take-over`). `signal` aborts it. */
  readonly runGates: (gates: readonly string[], signal: AbortSignal) => Promise<RerunResult>;
  readonly note: (title: string, body: string) => void;
  readonly log: (message: string) => void;
  /** Called with the reason when the re-run is refused; the log is a debug line, so this one reaches the user. */
  readonly refused?: (why: string) => void;
}

interface RerunFlight {
  readonly controller: AbortController;
  superseded: boolean;
  /** Resolves when the re-run has unwound (its run closed, its note written). */
  readonly ended: Promise<void>;
  readonly end: () => void;
}
const reruns = new Map<number, RerunFlight>();
const pushes = new Map<number, number>();

/**
 * A newer head exists (a manual push delivered, or an auto-deliver starts): abort a re-run on the older head and
 * record it as superseded, not failed (D540). Resolves when that re-run has unwound, so a new one may start.
 */
export function supersedeRerun(ticketId: number): Promise<void> {
  const flight = reruns.get(ticketId);
  if (flight === undefined) return Promise.resolve();
  flight.superseded = true;
  flight.controller.abort();
  return flight.ended;
}

/**
 * A manual push of this ticket begins. The returned function ends the push; no re-run starts before it. A click that
 * pushes nothing leaves a running re-run alone: the caller supersedes it with `supersedeRerun` once the push delivered.
 */
export function beginManualPush(ticketId: number): () => void {
  pushes.set(ticketId, (pushes.get(ticketId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (pushes.get(ticketId) ?? 1) - 1;
    if (left <= 0) pushes.delete(ticketId);
    else pushes.set(ticketId, left);
  };
}

/** The bulletin line when the re-run ends (@arch:AP-00: every action writes a note). */
export function deliverRerunNote(r: RerunResult | { readonly kind: 'superseded'; readonly headSha: string | null }): string {
  const head = `Autopilot: the gates skipped by the manual Deliver ran on ${shortSha(r.headSha)}`;
  if (r.kind === 'passed') return `${head}: passed`;
  if (r.kind === 'failed') return `${head}: failed: ${list(r.failed)}`;
  if (r.kind === 'superseded') return `${head}: superseded by a newer push`;
  return `${head}: stopped`;
}

/**
 * After a take-over push succeeded: run the gates the manual Deliver skipped, on the pushed head, in the background
 * (D540, @arch:AP-01). It never blocks the push. It refuses while an agent turn is active, a push is in flight or
 * another re-run runs, and says so in the log. A newer delivered push aborts it (`supersedeRerun`).
 */
export async function rerunSkippedGates(d: RerunDeps): Promise<RerunOutcome> {
  if (d.skipped.length === 0) return 'nothing';
  const refuse = (why: string): RerunOutcome => {
    d.log(`[ship] ticket ${d.key} skipped-gate re-run not started: ${why}`);
    d.refused?.(why);
    return 'refused';
  };
  if (d.agentActive()) return refuse('an agent turn is active');
  if (drainProbe?.() === true) return refuse('draining');
  const auto = inFlight.get(d.ticketId);
  if (auto !== undefined && !auto.takenOver) return refuse('an auto-deliver is running');
  if (pushes.has(d.ticketId)) return refuse('a push is in flight');
  if (reruns.has(d.ticketId)) return refuse('a re-run is already in progress');
  let end!: () => void;
  const ended = new Promise<void>((r) => { end = r; });
  const flight: RerunFlight = { controller: new AbortController(), superseded: false, ended, end };
  reruns.set(d.ticketId, flight);
  try {
    const result = await tracked(() => d.runGates(d.skipped, flight.controller.signal));
    const outcome: RerunOutcome = flight.superseded ? 'superseded' : result.kind;
    const title = deliverRerunNote(flight.superseded ? { kind: 'superseded', headSha: result.headSha } : result);
    d.note(title, `${d.key}: ${title.replace('Autopilot: ', '')}. A failure stays on record on the ship panel.`);
    d.log(`[ship] ticket ${d.key} skipped-gate re-run: ${outcome}`);
    return outcome;
  } finally {
    reruns.delete(d.ticketId);
    flight.end();
  }
}
