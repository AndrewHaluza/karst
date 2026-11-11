import type { Store } from '../../store/db.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { getTicket } from '../../store/tickets.js';
import { getStage } from '../../store/stages.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { clearOpenPrProbe } from '../../store/prs.js';
import { staleRebaseStep, type StaleRebaseSeams } from './autopilotStaleRebase.js';
import { transientRerunStep, type FailedCheck, type RerunContext, type TransientCiSeams } from './autopilotRerun.js';
import { noChangeStep, recordCiRoundHeads } from './autopilotNoChange.js';
import { ciFailureState } from '../../workflow/ciFailure.js';
import { restoreAwaitingMergeBlock } from '../../workflow/mergeGate.js';
import { parseChecks } from '../../model/prChecks.js';
import {
  clearConflictRound, effectiveAutopilot, setCiRoundHeadSha, getAutopilotTicket, getConflictRoundAt, grantAutopilotExtra, refundAutopilotAttempt,
  markConflictRound, setAutopilotPaused, setAutopilotStopAfter, setAutopilotStopped, stoppedReason, takeAutopilotAttempt,
  type AutopilotKind,
} from '../../store/autopilot.js';

/**
 * Autopilot (T973, T996): runs the SAME host action a user clicks at ship, without the click:
 * a failed CI check on the manifest allowlist -> Send CI failure to agent; a merge conflict with a known base head ->
 * Resolve conflicts (the resolved merge is delivered by karst behind the gates). A sandboxed ticket gets the same rounds
 * through the recorded placement (arch:AC-43); the sandbox never falls back to the host (arch:AC-31).
 *
 * Never auto: a rebase on base (except once for a stale generated file on a host ticket, arch:AP-05), push diverged, merge to base, a closed PR.
 * Every decision is a pure read of the store plus injected seams (`vscode`-free); a park writes a bulletin note, never a toast.
 */

/** What a fix action reports back. */
export type FixOutcome =
  | { readonly kind: 'sent' }
  /** This window lost the lease before the round started: nothing ran, nothing is parked. */
  | { readonly kind: 'lease-lost' }
  | { readonly kind: 'failed'; readonly reason: string }
  /**
   * The sandbox cannot run the round (read-only, dependency setup failed, dirty or diverged clone: arch:AC-31/46/47).
   * An environment blocker, not an agent failure: no attempt is used, the ticket pauses and the round is not retried.
   */
  | { readonly kind: 'env-blocker'; readonly reason: string };

/** Where the ticket runs, from its recorded placement (arch:AC-43). A placement that cannot be read rejects. */
export type Placement = 'host' | 'sandbox';

export interface AutopilotDeps {
  readonly store: Store;
  readonly ticketId: number;
  readonly key: string;
  readonly config: () => AutopilotConfig | undefined;
  /** This window controls the ticket (arch:AC-37). Only the controller arms a round. */
  readonly controls: () => boolean;
  /** An agent session is running, from the same ownership data as `controls` (any window). */
  readonly sessionRunning: () => boolean;
  /** The sub-task concurrency limit has no free slot (arch:CONCURRENCY); an auto round counts against it. */
  readonly concurrencyFull: () => boolean;
  /** Host or sandbox, from the recorded placement. Rejects when the placement cannot be read: the ticket then parks. */
  readonly placement: () => Promise<Placement>;
  /**
   * Sandbox tickets only: checks the sandbox BEFORE the hand-off (clone sync, dependency setup). Returns the blocker
   * reason, or null when the round may go out. A rejection is a blocker too. Never called for a host ticket.
   */
  readonly sandboxPreflight?: () => Promise<string | null>;
  /** The ticket ran an implementation graph: a hand-off to Implement would reach no agent. */
  readonly isGraphTicket: () => boolean;
  readonly sendCiFailure: () => Promise<FixOutcome>;
  /** The Resolve conflicts path for one repo (`resolveConflictRound`). */
  readonly sendConflict: (repo: string) => Promise<FixOutcome>;
  /** A conflict round is armed, or karst delivers its resolved merge now: no other round starts beside it. */
  readonly conflictRoundActive: () => boolean;
  /** True when a conflict round is armed but never delivered; the engine drops it with a note. */
  readonly conflictRoundStalled: () => boolean;
  readonly dropConflictRound: () => void;
  /** gh seams of the one re-run of a transient CI failure (T1019). Absent: no re-run, today's rules apply. */
  readonly transientCi?: TransientCiSeams;
  /** Host seams of the one rebase for a stale generated file (T1081, @arch:AP-05). Absent: today's rules apply. */
  readonly staleRebase?: StaleRebaseSeams;
  /** Clock for the re-run settle time. Default: `Date.now`. */
  readonly now?: () => number;
  /** Bulletin note (arch:BULLETIN) for every auto action and fallback. */
  readonly note: (title: string, body: string) => void;
  /** `[ship] autopilot ...` debug line. */
  readonly debug: (message: string) => void;
}

export type AutopilotResult =
  | { readonly kind: 'off' | 'idle' | 'not-controller' | 'busy' | 'queued' | 'nothing' }
  | { readonly kind: 'ask'; readonly reason: string }
  | { readonly kind: 'armed'; readonly problem: AutopilotKind; readonly used: number; readonly max: number }
  | { readonly kind: 'parked'; readonly reason: string }
  | { readonly kind: 'cleared' }
  /** A transient CI failure was re-run once (T1019); the ticket waits for the result. */
  | { readonly kind: 'rerun' }
  /** A host rebase and regenerate ran for a stale generated file (T1081); the ticket waits for the next CI run. */
  | { readonly kind: 'rebased' };

const LOG = '[ship] autopilot';

const GRAPH_REASON = 'auto-fix not run: graph ticket';
const UNKNOWN_PLACEMENT_REASON = 'auto-fix not run: placement unknown';
const STALLED_REASON = 'auto-fix stopped: conflict round did not deliver';

function openPrRepos(store: Store, ticketId: number): Set<string> {
  const rows = store.db
    .prepare("SELECT DISTINCT repo FROM prs WHERE ticket_id = ? AND status = 'open' AND url IS NOT NULL AND dismissed_at IS NULL")
    .all(ticketId) as Array<{ repo: string }>;
  return new Set(rows.map((r) => r.repo));
}

/** True when every failing check name is on the allowlist. An empty list allows nothing. */
export function allChecksAllowed(failing: readonly string[], allow: readonly string[]): boolean {
  return failing.length > 0 && allow.length > 0 && failing.every((n) => allow.includes(n));
}

/**
 * Drop the amber block this module wrote (its reason starts with `auto-fix`); never another block.
 * The park replaced the normal awaiting-merge block, so the normal reason is put back (the ticket is still shipped).
 */
export function clearParkBlock(store: Store, ticketId: number): void {
  if (stageBlock(store, ticketId, 'ship')?.reason.startsWith('auto-fix')) restoreAwaitingMergeBlock(store, ticketId);
}

/** A ship block of another kind than awaiting-merge (push-diverged, a gate park, ...). Awaiting-merge is the normal ship wait, where autopilot works. */
function foreignBlock(store: Store, ticketId: number): boolean {
  const block = stageBlock(store, ticketId, 'ship');
  return block !== null && block.kind !== 'awaiting-merge';
}

/** Tickets with a round in flight in this process: a second tick for the same ticket must not start another round. */
const inFlight = new Set<string>();

/** Queued rounds already announced with a note (one per signature), so a waiting tick stays quiet after the first. */
const queuedNotedByStore = new WeakMap<Store, Set<string>>();

function queuedNoted(store: Store): Set<string> {
  let set = queuedNotedByStore.get(store);
  if (!set) { set = new Set(); queuedNotedByStore.set(store, set); }
  return set;
}

function flightKeyOf(d: Pick<AutopilotDeps, 'store' | 'ticketId'>): string {
  return `${d.store.db.name}:${d.ticketId}`;
}

function park(d: Pick<AutopilotDeps, 'store' | 'ticketId' | 'key' | 'note' | 'debug'>, kind: AutopilotKind, reason: string, body: string, paused = false): AutopilotResult {
  // Another writer's block (push-diverged) owns the ship row: leave it untouched.
  if (foreignBlock(d.store, d.ticketId)) return { kind: 'idle' };
  // Re-park when another writer replaced or cleared the block, so the amber state matches the stop reason.
  if (getAutopilotTicket(d.store, d.ticketId).stoppedReason !== reason || stageBlock(d.store, d.ticketId, 'ship')?.reason !== reason) {
    setAutopilotStopped(d.store, d.ticketId, reason);
    if (paused) setAutopilotPaused(d.store, d.ticketId, reason);
    // The amber Needs you state: the existing awaiting-merge kind carries the reason (no new BlockerKind, @arch:BLOCKED).
    parkGateStage(d.store, { ticketId: d.ticketId, stageKey: 'ship', kind: 'awaiting-merge', reason, runAt: new Date().toISOString(), gates: [] });
    d.note(`Autopilot: ${reason}`, `${d.key} (${kind}): ${body}`);
    d.debug(`${LOG} ticket ${d.key} ${kind}: ${reason}`);
    return { kind: 'parked', reason };
  }
  // Already parked with this reason: nothing changed, so the views are not refreshed again.
  return { kind: 'nothing' };
}

/** One failing PR and the signature (its failing check names) its budget counts against. */
interface BudgetTarget { readonly repo: string; readonly signature: string }

interface Problem { readonly kind: 'ci'; readonly repo: string; readonly signature: string; readonly targets: readonly BudgetTarget[]; readonly failing?: readonly string[]; readonly cutShort?: boolean; readonly fails?: readonly FailedCheck[] }
// `failing` and `cutShort` cover EVERY failing PR (the action sends them all); `repo` and `signature` name the first PR in notes; `targets` holds the budget of EVERY failing PR.

/** `wait` = CI status is not known yet (pending or unreadable): neither act nor clear a park. */
function findProblem(d: AutopilotDeps): Problem | 'wait' | null {
  const ci = ciFailureState(d.store, d.ticketId);
  if (!ci.available) return ci.reason === 'not-failing' && provenClean(d) ? null : 'wait';
  // One failing PR does not make the others known: an open PR with an unknown or unreadable CI status keeps the ticket waiting.
  if (hasUnknownCi(d)) return 'wait';
  // The allowlist and the budget cover every failing PR, because the action sends the failures of all of them to the agent.
  const first = ci.prs[0]!;
  const own = [...new Set(first.failing.map((f) => f.name))].sort();
  const all = [...new Set(ci.prs.flatMap((p) => p.failing.map((f) => f.name)))].sort();
  // The stored list is capped: a larger failed count means a failing check may be hidden from the allowlist check.
  const cutShort = ci.prs.some((p) => (p.failedTotal ?? 0) > p.failing.length);
  const targets = ci.prs.map((p) => ({ repo: p.repo, signature: [...new Set(p.failing.map((f) => f.name))].sort().join('\n') }));
  const fails = ci.prs.flatMap((p) => p.failing.map((f) => ({ repo: p.repo, cwd: p.cwd, name: f.name, url: f.url })));
  return { kind: 'ci', repo: first.repo, signature: own.join('\n'), targets, failing: all, cutShort, fails };
}

/** An open PR whose stored CI rollup is missing, unreadable or unknown, or still has pending checks (its failing list is partial). */
function hasUnknownCi(d: AutopilotDeps): boolean {
  const rows = d.store.db
    .prepare("SELECT checks FROM prs WHERE ticket_id = ? AND status = 'open' AND url IS NOT NULL AND dismissed_at IS NULL")
    .all(d.ticketId) as Array<{ checks: string | null }>;
  return rows.some((r) => { const c = parseChecks(r.checks); return c === null || c.state === 'unknown' || c.pending > 0; });
}

/**
 * The problem is only GONE on positive evidence (arch:DONE, arch:GH-03): every open PR has a clean merge check
 * and a passing CI rollup. An unknown, missing, pending or unreadable status is never a pass.
 */
function provenClean(d: AutopilotDeps): boolean {
  const open = [...openPrRepos(d.store, d.ticketId)];
  if (open.length === 0) return false;
  const merge = new Map(listMergeChecksByTicket(d.store, d.ticketId).map((c) => [c.repo, c.state]));
  const rows = d.store.db
    .prepare("SELECT repo, checks FROM prs WHERE ticket_id = ? AND status = 'open' AND url IS NOT NULL AND dismissed_at IS NULL")
    .all(d.ticketId) as Array<{ repo: string; checks: string | null }>;
  const ci = new Map(rows.map((r) => [r.repo, parseChecks(r.checks)?.state]));
  return open.every((repo) => merge.get(repo) === 'clean' && ci.get(repo) === 'passing');
}

/** One autopilot pass over a ship-stage ticket. Safe to call every tick: it acts at most once per signature attempt. */
export async function autopilotTick(d: AutopilotDeps): Promise<AutopilotResult> {
  const cfg = d.config();
  const ticket = getTicket(d.store, d.ticketId);
  if (!cfg || ticket.stageCurrent !== 'ship' || !effectiveAutopilot(d.store, d.ticketId, cfg.enabled)) return { kind: 'off' };
  const state = getAutopilotTicket(d.store, d.ticketId);
  if (state.stopAfter || state.pausedReason !== null || ticket.pausedAt !== null) return { kind: 'idle' };
  // A ship saga in flight owns the ticket: no round while it runs.
  if (getStage(d.store, d.ticketId, 'ship')?.status === 'running') return { kind: 'busy' };
  // An undelivered round parked the ticket: the CI rollup is of the old head, so no round starts until a person acts (approve
  // one more, set the mode) or the PRs are proven clean.
  if (state.stoppedReason === STALLED_REASON && !provenClean(d)) return { kind: 'idle' };
  // Only a SHIPPED ticket (the awaiting-merge block) is worked: a ticket that waits for Confirm ship has no block, and its
  // stored CI result belongs to an older head. Push-diverged and every other foreign block need a person too.
  if (stageBlock(d.store, d.ticketId, 'ship')?.kind !== 'awaiting-merge') return { kind: 'idle' };
  if (!d.controls()) return { kind: 'not-controller' };
  if (d.sessionRunning() || ticket.agentState === 'running') return { kind: 'busy' };
  // The merge check stays 'conflicted' (and the CI rollup stays on the old head) until the resolved merge is pushed and
  // probed again, so no time cooldown can tell a round in progress from a new one: read the round state itself.
  // A round armed for a long time, with no agent and no delivery running, never delivered (the agent left the merge
  // unfinished or a gate failed). Drop it with a note: the budget then bounds the next attempt.
  // Only a round the engine sent can stall: the round of a manual Resolve conflicts click is not ours to drop.
  if (getConflictRoundAt(d.store, d.ticketId) !== null && d.conflictRoundStalled()) {
    d.dropConflictRound();
    d.debug(`${LOG} ticket ${d.key}: the conflict round did not deliver; it is dropped`);
    clearConflictRound(d.store, d.ticketId);
    // The probe may read the local merge commit as clean and the CI rollup is of the old head: no round (CI included) may
    // start on that. Park, so a person sees it; approve one more attempt or resolve it by hand.
    return park(d, 'conflicts', STALLED_REASON, 'the resolved merge was not delivered (the agent left it unfinished, or a gate failed). The round is dropped; approve one more attempt or resolve the conflict by hand.');
  } else if (d.conflictRoundActive()) {
    d.debug(`${LOG} ticket ${d.key}: no round, a conflict round is armed or its resolved merge is being delivered`);
    return { kind: 'busy' };
  }
  const flightKey = flightKeyOf(d);
  if (inFlight.has(flightKey)) return { kind: 'busy' };
  inFlight.add(flightKey);
  try {
    return await runRound(d, cfg, state);
  } finally {
    inFlight.delete(flightKey);
  }
}

async function runRound(d: AutopilotDeps, cfg: AutopilotConfig, state: ReturnType<typeof getAutopilotTicket>): Promise<AutopilotResult> {
  // A conflict comes first: the CI result of a conflicted PR belongs to a head that is about to change.
  const conflicted = conflictedPrs(d);
  if (conflicted.length > 0) {
    const round = await runConflictRound(d, cfg, conflicted);
    // Policy ask or an unknown base head starts no round: that conflict stays a click and must not block the CI path.
    if (round.kind !== 'ask') return round;
  }
  const problem = findProblem(d);
  if (problem === 'wait') return { kind: 'nothing' };
  if (!problem) {
    // The problem is gone: a stale park block and stop reason must not stay.
    const parked = stageBlock(d.store, d.ticketId, 'ship')?.reason.startsWith('auto-fix') === true;
    if (state.stoppedReason !== null) setAutopilotStopped(d.store, d.ticketId, null);
    clearParkBlock(d.store, d.ticketId);
    // A cleared park changes what the views show: report it so the sweep refreshes them.
    return parked ? { kind: 'cleared' } : { kind: 'nothing' };
  }
  if (cfg.ci.policy === 'ask') return { kind: 'ask', reason: 'ci policy is ask' };
  if (problem.cutShort) {
    return park(d, 'ci', 'auto-fix not run: the list of failing ci checks is cut short', 'the failing check list is cut short, so the allowlist cannot be checked; send the failure to the agent by hand.');
  }
  // A network fault is re-run once before any park or CI round (T1019). A graph ticket and an unreadable placement keep today's rules.
  // A stale generated file is fixed by one host rebase first (T1081); a host ticket only.
  const stale = await staleStep(d, problem);
  if ('result' in stale) return stale.result;
  const unchanged = await noChangeStepOf(d, problem);
  if (unchanged) return unchanged;
  const rerun = await transientStep(d, problem);
  if (rerun.kind === 'result') return rerun.result;
  if (!allChecksAllowed(problem.failing ?? [], cfg.ci.checks)) {
    const name = (problem.failing ?? []).find((n) => !cfg.ci.checks.includes(n)) ?? '(none)';
    const again = stale.earlier.has(name) ? ' (rebased once for a stale generated file and it failed again)' : rerun.earlier.has(name) ? ' (re-run once after a network error and it failed again)' : '';
    const reason = `auto-fix not run: ci check ${name} is not on the allowlist${again}`;
    return park(d, 'ci', reason, 'a failing check is not on the autopilot allowlist; send the failure to the agent by hand.');
  }
  // A graph ticket, or a placement that cannot be read, gets no round: park, write a note, spend no attempt.
  const placed = await placementOf(d, 'ci');
  if (placed.kind === 'park') return placed.result;
  if (d.concurrencyFull()) return queueWait(d, problem.kind, problem.repo, problem.signature);

  // One attempt per failing PR. A spent budget on any of them stops the round, and the attempts taken first are given back.
  const taken: BudgetTarget[] = [];
  let budget: { ok: true; used: number; max: number } | null = null;
  for (const target of problem.targets) {
    const b = takeAutopilotAttempt(d.store, d.ticketId, target.repo, problem.kind, target.signature, cfg.ci.maxAttempts);
    if (!b.ok) {
      for (const t of taken) refundAutopilotAttempt(d.store, d.ticketId, t.repo, problem.kind);
      return park(d, problem.kind, stoppedReason(problem.kind, b.used, b.max), `the budget for ${target.repo} is spent; approve one more attempt or fix it by hand.`);
    }
    taken.push(target);
    if (target.repo === problem.repo) budget = b;
  }
  if (budget === null) return { kind: 'nothing' };
  const refundAll = (): void => { for (const t of taken) refundAutopilotAttempt(d.store, d.ticketId, t.repo, problem.kind); };
  // A sandbox blocker parks the ticket here, in ship, BEFORE the hand-off moves it to Implement.
  const blocked = await sandboxGate(d, placed.placement, problem.kind, problem.repo, refundAll);
  if (blocked) return blocked;
  // An action that throws reached no agent: it costs no attempt and parks with the error, like a failed fetch.
  const outcome: FixOutcome = await d.sendCiFailure()
    .catch((err: unknown): FixOutcome => ({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) }));
  const settled = await settleRound(d, { kind: problem.kind, repo: problem.repo, used: budget.used, max: budget.max, action: 'Send CI failure to agent', refundAll }, outcome);
  // Remember the head the failing run had: a later failure on the same head means this round made no commit (D564).
  if (settled.kind === 'armed' && d.transientCi && problem.fails) await recordCiRoundHeads(rerunContext(d, d.transientCi), problem.fails);
  return settled;
}

function rerunContext(d: AutopilotDeps, seams: TransientCiSeams): RerunContext {
  return { store: d.store, ticketId: d.ticketId, key: d.key, seams, now: d.now ?? Date.now, note: d.note, debug: d.debug };
}

/**
 * The no-change step (D564): a result to return, or null when today's rules go on. A CI round that made no commit leaves the
 * failing run on the recorded head; that run is re-run once at no attempt cost, and a second failure parks the ticket.
 */
async function noChangeStepOf(d: AutopilotDeps, problem: Problem): Promise<AutopilotResult | null> {
  if (!d.transientCi || !problem.fails) return null;
  if (d.isGraphTicket() || (await d.placement().catch(() => null)) === null) return null;
  const step = await noChangeStep(rerunContext(d, d.transientCi), problem.fails);
  if (step.kind === 'none') return null;
  if (step.kind === 'rerun') return { kind: 'rerun' };
  if (step.kind === 'stopped') {
    return park(d, 'ci', 'auto-fix stopped: ci round made no change', 'the agent made no commit and the check failed again after one re-run; fix it by hand or approve one more attempt.');
  }
  return park(d, 'ci', `auto-fix stopped: ci could not run (${step.reason})`, `the action failed (${step.reason}); the ticket stays in ship and no attempt was used.`, true);
}

/** The stale generated file step (T1081): a result to return, or the checks that were rebased before (for the park reason). */
async function staleStep(d: AutopilotDeps, problem: Problem): Promise<{ result: AutopilotResult } | { earlier: ReadonlySet<string> }> {
  const none = { earlier: new Set<string>() };
  if (!d.staleRebase || !problem.fails) return none;
  // A graph ticket and a sandboxed ticket keep today's rules: Rebase on base never runs in a sandbox round (@arch:AP-04).
  const placed = await d.placement().catch(() => null);
  if (d.isGraphTicket() || placed === null || placed === 'sandbox') return none;
  const step = await staleRebaseStep(
    { store: d.store, ticketId: d.ticketId, key: d.key, seams: d.staleRebase, now: d.now ?? Date.now, note: d.note, debug: d.debug },
    problem.fails,
  );
  return step.kind === 'rebased' ? { result: { kind: 'rebased' } } : { earlier: step.earlier };
}

/** The transient re-run step: a result to return, or the checks that were re-run before (for the park reason). */
async function transientStep(d: AutopilotDeps, problem: Problem): Promise<{ kind: 'result'; result: AutopilotResult } | { kind: 'go'; earlier: ReadonlySet<string> }> {
  const none = { kind: 'go', earlier: new Set<string>() } as const;
  if (!d.transientCi || !problem.fails) return none;
  if (d.isGraphTicket() || (await d.placement().catch(() => null)) === null) return none;
  const step = await transientRerunStep(
    { store: d.store, ticketId: d.ticketId, key: d.key, seams: d.transientCi, now: d.now ?? Date.now, note: d.note, debug: d.debug },
    problem.fails,
  );
  if (step.kind === 'none') return { kind: 'go', earlier: step.earlier };
  if (step.kind === 'rerun') return { kind: 'result', result: { kind: 'rerun' } };
  // An unknown result is never a pass: park as a failed action does.
  return { kind: 'result', result: park(d, 'ci', `auto-fix stopped: ci could not run (${step.reason})`, `the action failed (${step.reason}); the ticket stays in ship and no attempt was used.`, true) };
}

type PlacementGate = { readonly kind: 'go'; readonly placement: Placement } | { readonly kind: 'park'; readonly result: AutopilotResult };

/** A graph ticket or an unreadable placement gets no round: park with a note and spend no attempt. */
async function placementOf(d: AutopilotDeps, kind: AutopilotKind): Promise<PlacementGate> {
  const hand = kind === 'ci' ? 'Send the failure to the agent' : 'Resolve the conflict';
  if (d.isGraphTicket()) {
    return { kind: 'park', result: park(d, kind, GRAPH_REASON, `the ticket ran an implementation graph, so a hand-off to Implement would reach no agent. ${hand} by hand.`) };
  }
  try {
    return { kind: 'go', placement: await d.placement() };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { kind: 'park', result: park(d, kind, UNKNOWN_PLACEMENT_REASON, `the recorded placement cannot be read (${why}); autopilot never guesses the environment. ${hand} by hand.`) };
  }
}

/** The pause of an environment blocker: visible on the ship row, kept apart from a spent budget, never retried. */
function sandboxPause(d: AutopilotDeps, kind: AutopilotKind, reason: string): AutopilotResult {
  return park(d, kind, `auto-fix paused: sandbox ${reason}`, `the sandbox cannot run the ${kind} round (${reason}); no attempt was used and the round is not retried. Fix the sandbox, then set the auto-fix mode again.`, true);
}

/**
 * The pre-hand-off sandbox check. A blocker gives the attempts back and pauses the ticket in ship. A host ticket,
 * or a deps without the seam, passes. A rejection of the seam is a blocker: the environment is not known to be fine.
 */
async function sandboxGate(d: AutopilotDeps, placement: Placement, kind: AutopilotKind, repo: string, refundAll: () => void): Promise<AutopilotResult | null> {
  if (placement !== 'sandbox' || !d.sandboxPreflight) return null;
  const reason = await d.sandboxPreflight().catch((err: unknown): string => (err instanceof Error ? err.message : String(err)));
  if (reason === null) return null;
  refundAll();
  d.debug(`${LOG} ticket ${d.key} ${kind} round for ${repo} blocked by the sandbox: ${reason}`);
  return sandboxPause(d, kind, reason);
}

/** A waiting round must be visible: one note per signature (not per tick), plus a debug line each time. */
function queueWait(d: AutopilotDeps, kind: AutopilotKind, repo: string, signature: string): AutopilotResult {
  const waitKey = `${flightKeyOf(d)}:${kind}:${repo}:${signature}`;
  d.debug(`${LOG} ticket ${d.key} ${kind} round for ${repo} is waiting for a free concurrency slot`);
  if (!queuedNoted(d.store).has(waitKey)) {
    queuedNoted(d.store).add(waitKey);
    d.note(`Autopilot: ${kind} round is waiting`, `${d.key}: the ${kind} round for ${repo} waits for a free sub-task slot; it starts when one is free.`);
  }
  return { kind: 'queued' };
}

interface Settle { readonly kind: AutopilotKind; readonly repo: string; readonly used: number; readonly max: number; readonly action: string; readonly refundAll: () => void }

/** What a round's action did: a sent round arms, a lost lease is quiet, a failed action costs no attempt and parks. */
async function settleRound(d: AutopilotDeps, r: Settle, outcome: FixOutcome): Promise<AutopilotResult> {
  if (outcome.kind === 'lease-lost') {
    // Another window owns the round now: give the attempt back and stay quiet.
    r.refundAll();
    return { kind: 'not-controller' };
  }
  if (outcome.kind === 'sent') {
    // The stored CI rollup and merge block belong to the head the resolved merge replaces: forget them, so a stale
    // failure never starts a CI round and a stale conflict never starts a second conflict round.
    if (r.kind === 'conflicts') { clearOpenPrProbe(d.store, d.ticketId, r.repo); markConflictRound(d.store, d.ticketId, Date.now()); }
    queuedNoted(d.store).clear();
    setAutopilotStopped(d.store, d.ticketId, null);
    clearParkBlock(d.store, d.ticketId);
    d.note(`Autopilot: ${r.kind} round ${r.used}/${r.max}`, `${d.key}: ran ${r.action} for ${r.repo} (round ${r.used}/${r.max}).`);
    d.debug(`${LOG} ticket ${d.key} ${r.kind} round ${r.used}/${r.max} armed for ${r.repo}`);
    lastRound.set(flightKeyOf(d), { kind: r.kind, repo: r.repo, refundAll: r.refundAll, sentAt: Date.now() });
    return { kind: 'armed', problem: r.kind, used: r.used, max: r.max };
  }
  // A failed action reached no agent: it costs no attempt and is not retried. A failed conflict round must not stay armed:
  // a later manual session would get auto-delivery.
  r.refundAll();
  if (r.kind === 'conflicts') { d.dropConflictRound(); clearConflictRound(d.store, d.ticketId); }
  if (outcome.kind === 'env-blocker') {
    return getTicket(d.store, d.ticketId).stageCurrent !== 'ship'
      ? pauseLeftShip(d, r, `auto-fix paused: sandbox ${outcome.reason}`, outcome.reason)
      : sandboxPause(d, r.kind, outcome.reason);
  }
  if (getTicket(d.store, d.ticketId).stageCurrent !== 'ship') {
    return pauseLeftShip(d, r, `auto-fix paused: ${r.kind} session did not start (${outcome.reason})`, outcome.reason);
  }
  return park(d, r.kind, `auto-fix stopped: ${r.kind} could not run (${outcome.reason})`, `the action failed (${outcome.reason}); the ticket stays in ship and no attempt was used.`, true);
}

/**
 * The action already moved the ticket on (CI hand-off to Implement) but no session got the task. The ship row is not
 * ours to park, so pause autopilot (it stays quiet until a person sets the mode again) and leave a visible stop reason.
 */
function pauseLeftShip(d: AutopilotDeps, r: Pick<Settle, 'kind' | 'repo'>, reason: string, detail: string): AutopilotResult {
  setAutopilotStopped(d.store, d.ticketId, reason);
  setAutopilotPaused(d.store, d.ticketId, reason);
  d.note(`Autopilot: ${reason}`, `${d.key}: the ${r.kind} round for ${r.repo} moved the ticket to Implement but no session started; no attempt was used. Start the agent by hand, then set the auto-fix mode again to resume.`);
  d.debug(`${LOG} ticket ${d.key} ${r.kind} left ship before the failure: ${detail}`);
  return { kind: 'parked', reason };
}

/** The round the engine sent last, per ticket: what a session that dies right after launch must undo. */
const lastRound = new Map<string, { readonly kind: AutopilotKind; readonly repo: string; readonly refundAll: () => void; readonly sentAt: number }>();

/** A session that dies "right after launch" does so inside this window; a later launch failure is not this round's. */
export const ROUND_LAUNCH_DEATH_WINDOW_MS = 2 * 60_000;

/**
 * A session that died right after launch (reported later by the launch-failure path, not by the hand-off): the round did
 * not reach an agent. It is not a sent round: the attempt is given back, a conflict round is dropped, and the ticket
 * pauses with a visible reason so the round is not retried. Null when no round is recorded for the ticket.
 */
export function roundDied(d: Pick<AutopilotDeps, 'store' | 'ticketId' | 'key' | 'note' | 'debug' | 'dropConflictRound'>, detail: string): AutopilotResult | null {
  const key = flightKeyOf(d);
  const r = lastRound.get(key);
  if (!r) return null;
  lastRound.delete(key);
  if (Date.now() - r.sentAt > ROUND_LAUNCH_DEATH_WINDOW_MS) {
    d.debug(`${LOG} ticket ${d.key} launch failure ignored: the ${r.kind} round was sent more than ${ROUND_LAUNCH_DEATH_WINDOW_MS / 1000}s ago`);
    return null;
  }
  r.refundAll();
  if (r.kind === 'conflicts') { d.dropConflictRound(); clearConflictRound(d.store, d.ticketId); }
  const reason = `auto-fix paused: ${r.kind} session died after launch (${detail})`;
  if (getTicket(d.store, d.ticketId).stageCurrent === 'ship') {
    return park(d, r.kind, reason, `the session of the ${r.kind} round for ${r.repo} died after launch (${detail}); the attempt was given back and the round is not retried. Start the agent by hand, then set the auto-fix mode again.`, true);
  }
  setAutopilotStopped(d.store, d.ticketId, reason);
  setAutopilotPaused(d.store, d.ticketId, reason);
  d.note(`Autopilot: ${reason}`, `${d.key}: the session of the ${r.kind} round for ${r.repo} died after launch (${detail}); the attempt was given back and the round is not retried.`);
  d.debug(`${LOG} ticket ${d.key} ${r.kind} session died after launch: ${detail}`);
  return { kind: 'parked', reason };
}

/** One open PR with a recorded merge conflict. `baseSha` is null when the probe did not name the base head. */
interface ConflictedPr { readonly repo: string; readonly baseSha: string | null }

/** Open PRs whose stored merge check says conflicted, in repo order. A closed or merged PR is never fixed. */
function conflictedPrs(d: AutopilotDeps): ConflictedPr[] {
  const open = openPrRepos(d.store, d.ticketId);
  return listMergeChecksByTicket(d.store, d.ticketId)
    .filter((c) => c.state === 'conflicted' && open.has(c.repo))
    .map((c) => ({ repo: c.repo, baseSha: c.baseSha }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

/**
 * One conflict round (T996): the Resolve conflicts path for ONE repo. The budget is per (PR, conflicts) with the base head
 * as its signature, so a new base head starts a new count. A spent repo is skipped while another conflicted PR still has
 * attempts; the ticket parks only when every actionable PR is spent. An unknown base head stays a manual click.
 */
async function runConflictRound(d: AutopilotDeps, cfg: AutopilotConfig, conflicted: readonly ConflictedPr[]): Promise<AutopilotResult> {
  if (cfg.conflicts.policy === 'ask') return { kind: 'ask', reason: 'conflicts policy is ask' };
  const known = conflicted.filter((c): c is { repo: string; baseSha: string } => c.baseSha !== null);
  if (known.length === 0) {
    d.debug(`${LOG} ticket ${d.key}: conflict on ${conflicted.map((c) => c.repo).join(', ')} has no known base head; resolve it by hand`);
    return { kind: 'ask', reason: 'base head of the conflict is unknown' };
  }
  const placed = await placementOf(d, 'conflicts');
  if (placed.kind === 'park') return placed.result;
  let spent: { repo: string; used: number; max: number } | null = null;
  for (const target of known) {
    const b = takeAutopilotAttempt(d.store, d.ticketId, target.repo, 'conflicts', target.baseSha, cfg.conflicts.maxRounds);
    if (!b.ok) { spent ??= { repo: target.repo, used: b.used, max: b.max }; continue; }
    // The budget is checked first: a spent ticket parks instead of waiting, and a waiting ticket keeps its attempt.
    if (d.concurrencyFull()) { refundAutopilotAttempt(d.store, d.ticketId, target.repo, 'conflicts'); return queueWait(d, 'conflicts', target.repo, target.baseSha); }
    const refundAll = (): void => refundAutopilotAttempt(d.store, d.ticketId, target.repo, 'conflicts');
    const blocked = await sandboxGate(d, placed.placement, 'conflicts', target.repo, refundAll);
    if (blocked) return blocked;
    // An action that throws reached no agent: it costs no attempt and parks with the error.
    const outcome: FixOutcome = await d.sendConflict(target.repo)
      .catch((err: unknown): FixOutcome => ({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) }));
    return settleRound(d, { kind: 'conflicts', repo: target.repo, used: b.used, max: b.max, action: 'Resolve conflicts', refundAll }, outcome);
  }
  // Every actionable conflicted PR is spent. `spent` is set, because `known` is not empty.
  const first = spent!;
  const repos = known.map((c) => c.repo).join(', ');
  return park(d, 'conflicts', stoppedReason('conflicts', first.used, first.max), `the conflict budget for ${repos} is spent; approve one more attempt or resolve it by hand.`);
}

export interface AutopilotCommandDeps {
  readonly store: Store;
  readonly ticketId: number;
  readonly key: string;
  readonly note: (title: string, body: string) => void;
  readonly debug: (message: string) => void;
  /** "Stop now": end the session through the existing stop path. True when the stop reached a session this window holds; false when it did not. */
  readonly stopSession: () => Promise<boolean>;
}

/** "Approve 1 more": a one-off +1 for this PR and kind. It never resets the counter. */
export function approveOneMore(d: Pick<AutopilotCommandDeps, 'store' | 'ticketId' | 'key' | 'note' | 'debug'>, repo: string, kind: AutopilotKind): void {
  const b = grantAutopilotExtra(d.store, d.ticketId, repo, kind);
  // A person decided: the no-change state of the last CI round is cleared, so the approved attempt can start.
  if (kind === 'ci') setCiRoundHeadSha(d.store, d.ticketId, repo, null);
  clearParkBlock(d.store, d.ticketId);
  d.note(`Autopilot: one more ${kind} attempt approved`, `${d.key}: ${repo} now has ${b.extra} extra attempt(s) (${b.attempts} used).`);
  d.debug(`${LOG} ticket ${d.key} ${kind} +1 approved for ${repo}`);
}

/** What a stop did: only the flag was set, the session ended, or the stop did not reach the session. */
export type StopResult = 'flag-set' | 'ended' | 'not-reached';

/** "Stop after this round" sets the flag; "now" also ends the running session when this window holds it. */
export async function stopAutopilot(d: AutopilotCommandDeps, when: 'after-round' | 'now'): Promise<StopResult> {
  setAutopilotStopAfter(d.store, d.ticketId);
  d.debug(`${LOG} ticket ${d.key} stop ${when}`);
  if (when === 'after-round') {
    d.note('Autopilot: stopped after this round', `${d.key}: a person stopped auto-fix after the current round.`);
    return 'flag-set';
  }
  const reached = await d.stopSession();
  d.note(
    'Autopilot: stopped now',
    reached
      ? `${d.key}: a person stopped auto-fix and ended the session.`
      : `${d.key}: a person stopped auto-fix. The stop did not reach the session: another window holds it, or none is open.`,
  );
  return reached ? 'ended' : 'not-reached';
}
