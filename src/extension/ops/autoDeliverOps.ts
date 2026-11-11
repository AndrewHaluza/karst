import { deliverToPr, type DeliverDeps } from './deliverToPrOps.js';
import type { DeliverPr } from '../../workflow/deliverState.js';
import type { GitResult } from './deliverToPrOps.js';
import type { Store } from '../../store/db.js';
import { getTicket } from '../../store/tickets.js';
import { getMergeCheck } from '../../store/mergeChecks.js';
import { clearConflictRound } from '../../store/autopilot.js';
import { shortSha } from '../../model/inside/deliver.js';

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

export interface ConflictRounds {
  arm(ticketId: number, round: ResolvedRound): void;
  armed(ticketId: number): ResolvedRound | null;
  /** When the round was armed (ms), or null. */
  armedAt(ticketId: number): number | null;
  disarm(ticketId: number): void;
}

/**
 * In memory on purpose: a reload loses the session too, and the manual Deliver button remains. `onDisarm` lets the store
 * forget the round's slot (T996) when the round ends: delivered, dropped, stopped.
 */
export function createConflictRounds(onDisarm?: (ticketId: number) => void): ConflictRounds {
  const byTicket = new Map<number, ResolvedRound>();
  const since = new Map<number, number>();
  return {
    arm: (ticketId, round) => { byTicket.set(ticketId, round); since.set(ticketId, Date.now()); },
    armedAt: (ticketId) => since.get(ticketId) ?? null,
    armed: (ticketId) => byTicket.get(ticketId) ?? null,
    disarm: (ticketId) => { byTicket.delete(ticketId); since.delete(ticketId); onDisarm?.(ticketId); },
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
  readonly runGates: (prs: readonly DeliverPr[], signal: AbortSignal) => Promise<string | null>;
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

/** The auto-deliver of a resolved merge runs now for this ticket (T996: no second conflict round beside it). */
export function isAutoDelivering(ticketId: number): boolean {
  return inFlight.has(ticketId);
}

/** An armed round with no agent and no delivery for this long never delivered (the agent left it unfinished, or a gate failed). */
export const CONFLICT_ROUND_STALL_MS = 5 * 60_000;

export function isConflictRoundStalled(rounds: ConflictRounds, ticketId: number, now: number = Date.now()): boolean {
  const at = rounds.armedAt(ticketId);
  return at !== null && !isAutoDelivering(ticketId) && now - at > CONFLICT_ROUND_STALL_MS;
}

/** Run on a Stop/session.idle of a ticket; a no-op unless a Resolve-conflicts round is armed for it. */
export async function autoDeliverAfterConflict(d: AutoDeliverDeps): Promise<void> {
  const round = d.rounds.armed(d.ticketId);
  if (round === null || inFlight.has(d.ticketId) || d.agentActive()) return;
  const targets = d.targets();
  if (!targets.available) return; // not at ship, no open PR, or a ship run is in flight: the manual button decides
  const entry: InFlight = { controller: new AbortController(), phase: 'gates', takenOver: false };
  inFlight.set(d.ticketId, entry);
  try {
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
        const failed = await d.runGates(targets.prs, entry.controller.signal);
        if (entry.takenOver) return TAKEN_OVER;
        if (failed !== null) {
          d.error(`Resolved merge not delivered: a ship-stage gate failed — ${failed}`);
          return failed;
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
  } finally {
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
}

interface RerunFlight {
  readonly controller: AbortController;
  superseded: boolean;
}
const reruns = new Map<number, RerunFlight>();
const pushes = new Map<number, number>();

/**
 * A manual push of this ticket begins: a re-run of the skipped gates on an older head is aborted, and it is
 * recorded as superseded, not failed (D540). The returned function ends the push; no re-run starts before it.
 */
export function beginManualPush(ticketId: number): () => void {
  const flight = reruns.get(ticketId);
  if (flight !== undefined) {
    flight.superseded = true;
    flight.controller.abort();
  }
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
 * another re-run runs, and says so in the log. A newer push aborts it (`beginManualPush`).
 */
export async function rerunSkippedGates(d: RerunDeps): Promise<RerunOutcome> {
  if (d.skipped.length === 0) return 'nothing';
  const refuse = (why: string): RerunOutcome => {
    d.log(`[ship] ticket ${d.key} skipped-gate re-run not started: ${why}`);
    return 'refused';
  };
  if (d.agentActive()) return refuse('an agent turn is active');
  if (pushes.has(d.ticketId)) return refuse('a push is in flight');
  if (reruns.has(d.ticketId)) return refuse('a re-run is already in progress');
  const flight: RerunFlight = { controller: new AbortController(), superseded: false };
  reruns.set(d.ticketId, flight);
  try {
    const result = await d.runGates(d.skipped, flight.controller.signal);
    const outcome: RerunOutcome = flight.superseded ? 'superseded' : result.kind;
    const title = deliverRerunNote(flight.superseded ? { kind: 'superseded', headSha: result.headSha } : result);
    if (outcome !== 'stopped') d.note(title, `${d.key}: ${title.replace(/^Autopilot: /, '')}. A failure stays on record on the ship panel.`);
    d.log(`[ship] ticket ${d.key} skipped-gate re-run: ${outcome}`);
    return outcome;
  } finally {
    reruns.delete(d.ticketId);
  }
}
