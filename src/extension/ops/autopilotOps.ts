import type { Store } from '../../store/db.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { getTicket } from '../../store/tickets.js';
import { getStage } from '../../store/stages.js';
import { decideBudget, getAutopilotBudget } from '../../store/autopilot.js';
import { clearStageBlock, parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { clearOpenPrProbe } from '../../store/prs.js';
import { ciFailureState } from '../../workflow/ciFailure.js';
import {
  effectiveAutopilot, getAutopilotTicket, grantAutopilotExtra, pausedReason, refundAutopilotAttempt,
  setAutopilotPaused, setAutopilotStopAfter, setAutopilotStopped, stoppedReason, takeAutopilotAttempt,
  type AutopilotKind,
} from '../../store/autopilot.js';

/**
 * Autopilot (T973): runs the SAME host actions a user clicks at ship, without the click.
 *
 *  - merge conflict on an open PR -> Resolve conflicts ONLY (never Rebase on base: it can drop unsynced sandbox commits);
 *  - failed CI check on the manifest allowlist -> Send CI failure to agent.
 *
 * Never auto: push diverged (Integrate / Overwrite remote), merge to base, a closed PR, a sandbox host fallback.
 * Every decision is a pure read of the store plus injected seams (`vscode`-free); a park writes a bulletin note, never a toast.
 */

/** What a fix action reports back. `env-blocker` = a sandbox environment problem (read-only, setup failure, dirty/diverged clone). */
export type FixOutcome =
  | { readonly kind: 'sent' }
  /** This window lost the lease before the round started: nothing ran, nothing is parked. */
  | { readonly kind: 'lease-lost' }
  | { readonly kind: 'env-blocker'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

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
  /** Resolve conflicts for `repo`. Must never rebase and never fall back to the host. */
  readonly resolveConflicts: (repo: string) => Promise<FixOutcome>;
  readonly sendCiFailure: () => Promise<FixOutcome>;
  /** Bulletin note (arch:BULLETIN) for every auto action and fallback. */
  readonly note: (title: string, body: string) => void;
  /** `[ship] autopilot ...` debug line. */
  readonly debug: (message: string) => void;
}

export type AutopilotResult =
  | { readonly kind: 'off' | 'idle' | 'not-controller' | 'busy' | 'queued' | 'nothing' }
  | { readonly kind: 'ask'; readonly reason: string }
  | { readonly kind: 'armed'; readonly problem: AutopilotKind; readonly used: number; readonly max: number }
  | { readonly kind: 'parked'; readonly reason: string };

const LOG = '[ship] autopilot';

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

/** Drop the amber block this module wrote (its reason starts with `auto-fix`); never another block. */
export function clearParkBlock(store: Store, ticketId: number): void {
  if (stageBlock(store, ticketId, 'ship')?.reason.startsWith('auto-fix')) clearStageBlock(store, ticketId, 'ship');
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

function park(d: AutopilotDeps, kind: AutopilotKind, reason: string, body: string, paused = false): AutopilotResult {
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
  }
  return { kind: 'parked', reason };
}

interface Problem { readonly kind: AutopilotKind; readonly repo: string; readonly signature: string; readonly failing?: readonly string[] }

/** `wait` = CI status is not known yet (pending or unreadable): neither act nor clear a park. */
function findProblem(d: AutopilotDeps, maxRounds: number): Problem | 'wait' | null {
  const open = openPrRepos(d.store, d.ticketId);
  const candidates = listMergeChecksByTicket(d.store, d.ticketId).filter((c) => c.state === 'conflicted' && open.has(c.repo) && c.baseSha);
  // A conflict with an unknown base head has no signature to count against: leave it to the manual click.
  // A repo with a spent budget must not hide another conflicted PR of the ticket: prefer one with budget left.
  const open1 = candidates.find((c) => decideBudget(getAutopilotBudget(d.store, d.ticketId, c.repo, 'conflicts'), c.baseSha!, maxRounds).decision.ok);
  const conflicted = open1 ?? candidates[0];
  if (conflicted) return { kind: 'conflicts', repo: conflicted.repo, signature: conflicted.baseSha! };
  const ci = ciFailureState(d.store, d.ticketId);
  if (!ci.available) return ci.reason === 'not-failing' || ci.reason === 'stage' ? null : 'wait';
  const names = ci.prs.flatMap((p) => p.failing.map((f) => f.name)).sort();
  return { kind: 'ci', repo: ci.prs[0]!.repo, signature: [...new Set(names)].join('\n'), failing: [...new Set(names)] };
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
  // Push-diverged and every other foreign block need a person: no round runs over them.
  if (foreignBlock(d.store, d.ticketId)) return { kind: 'idle' };
  if (!d.controls()) return { kind: 'not-controller' };
  if (d.sessionRunning() || ticket.agentState === 'running') return { kind: 'busy' };
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

  const problem = findProblem(d, cfg.conflicts.maxRounds);
  if (problem === 'wait') return { kind: 'nothing' };
  if (!problem) {
    // The problem is gone: a stale park block and stop reason must not stay.
    if (state.stoppedReason !== null) setAutopilotStopped(d.store, d.ticketId, null);
    clearParkBlock(d.store, d.ticketId);
    return { kind: 'nothing' };
  }
  const policy = problem.kind === 'conflicts' ? cfg.conflicts : cfg.ci;
  if (policy.policy === 'ask') return { kind: 'ask', reason: `${problem.kind} policy is ask` };
  if (problem.kind === 'ci' && !allChecksAllowed(problem.failing ?? [], cfg.ci.checks)) {
    const reason = `auto-fix not run: ci check ${(problem.failing ?? []).find((n) => !cfg.ci.checks.includes(n)) ?? '(none)'} is not on the allowlist`;
    return park(d, 'ci', reason, 'a failing check is not on the autopilot allowlist; send the failure to the agent by hand.');
  }
  if (d.concurrencyFull()) {
    // A waiting round must be visible: one note per signature (not per tick), plus a debug line each time.
    const waitKey = `${flightKeyOf(d)}:${problem.kind}:${problem.repo}:${problem.signature}`;
    d.debug(`${LOG} ticket ${d.key} ${problem.kind} round for ${problem.repo} is waiting for a free concurrency slot`);
    if (!queuedNoted(d.store).has(waitKey)) {
      queuedNoted(d.store).add(waitKey);
      d.note(`Autopilot: ${problem.kind} round is waiting`, `${d.key}: the ${problem.kind} round for ${problem.repo} waits for a free sub-task slot; it starts when one is free.`);
    }
    return { kind: 'queued' };
  }

  const max = problem.kind === 'conflicts' ? cfg.conflicts.maxRounds : cfg.ci.maxAttempts;
  const budget = takeAutopilotAttempt(d.store, d.ticketId, problem.repo, problem.kind, problem.signature, max);
  if (!budget.ok) {
    return park(d, problem.kind, stoppedReason(problem.kind, budget.used, budget.max), `the budget for ${problem.repo} is spent; approve one more attempt or fix it by hand.`);
  }
  const outcome = problem.kind === 'conflicts' ? await d.resolveConflicts(problem.repo) : await d.sendCiFailure();
  if (outcome.kind === 'lease-lost') {
    // Another window owns the round now: give the attempt back and stay quiet.
    refundAutopilotAttempt(d.store, d.ticketId, problem.repo, problem.kind);
    return { kind: 'not-controller' };
  }
  if (outcome.kind === 'sent') {
    // The stored CI rollup belongs to the head the resolved merge replaces: forget it, so a stale failure never starts a CI round.
    if (problem.kind === 'conflicts') clearOpenPrProbe(d.store, d.ticketId, problem.repo);
    queuedNoted(d.store).clear();
    setAutopilotStopped(d.store, d.ticketId, null);
    clearParkBlock(d.store, d.ticketId);
    d.note(`Autopilot: ${problem.kind} round ${budget.used}/${budget.max}`, `${d.key}: ran ${problem.kind === 'conflicts' ? 'Resolve conflicts' : 'Send CI failure to agent'} for ${problem.repo} (round ${budget.used}/${budget.max}).`);
    d.debug(`${LOG} ticket ${d.key} ${problem.kind} round ${budget.used}/${budget.max} armed for ${problem.repo}`);
    return { kind: 'armed', problem: problem.kind, used: budget.used, max: budget.max };
  }
  // Neither an environment blocker nor a failed fetch reached the agent: they cost no attempt and are not retried.
  refundAutopilotAttempt(d.store, d.ticketId, problem.repo, problem.kind);
  if (getTicket(d.store, d.ticketId).stageCurrent !== 'ship') {
    // The action already moved the ticket on (CI hand-off to Implement) but no session got the task. The ship row is not ours
    // to park, so pause autopilot (it stays quiet until a person sets the mode again) and leave a visible stop reason.
    const reason = `auto-fix paused: ${problem.kind} session did not start (${outcome.reason})`;
    setAutopilotStopped(d.store, d.ticketId, reason);
    setAutopilotPaused(d.store, d.ticketId, reason);
    d.note(`Autopilot: ${reason}`, `${d.key}: the ${problem.kind} round for ${problem.repo} moved the ticket to Implement but no session started; no attempt was used. Start the agent by hand, then set the auto-fix mode again to resume.`);
    d.debug(`${LOG} ticket ${d.key} ${problem.kind} left ship before the failure: ${outcome.reason}`);
    return { kind: 'parked', reason };
  }
  if (outcome.kind === 'env-blocker') {
    return park(d, problem.kind, pausedReason(outcome.reason), `the sandbox cannot run a round (${outcome.reason}); no attempt was used and the host fallback is never taken.`, true);
  }
  return park(d, problem.kind, `auto-fix stopped: ${problem.kind} could not run (${outcome.reason})`, `the action failed (${outcome.reason}); the ticket stays in ship and no attempt was used.`, true);
}

export interface AutopilotCommandDeps {
  readonly store: Store;
  readonly ticketId: number;
  readonly key: string;
  readonly note: (title: string, body: string) => void;
  readonly debug: (message: string) => void;
  /** "Stop now": end the running session through the existing stop path (a sandboxed ticket syncs sandbox -> host first, AC-37). */
  readonly stopSession: () => Promise<void>;
}

/** "Approve 1 more": a one-off +1 for this PR and kind. It never resets the counter. */
export function approveOneMore(d: Pick<AutopilotCommandDeps, 'store' | 'ticketId' | 'key' | 'note' | 'debug'>, repo: string, kind: AutopilotKind): void {
  const b = grantAutopilotExtra(d.store, d.ticketId, repo, kind);
  clearParkBlock(d.store, d.ticketId);
  d.note(`Autopilot: one more ${kind} attempt approved`, `${d.key}: ${repo} now has ${b.extra} extra attempt(s) (${b.attempts} used).`);
  d.debug(`${LOG} ticket ${d.key} ${kind} +1 approved for ${repo}`);
}

/** "Stop after this round" sets the flag; "now" also ends the running session. */
export async function stopAutopilot(d: AutopilotCommandDeps, when: 'after-round' | 'now'): Promise<void> {
  setAutopilotStopAfter(d.store, d.ticketId);
  d.note(`Autopilot: stopped ${when === 'now' ? 'now' : 'after this round'}`, `${d.key}: a person stopped auto-fix ${when === 'now' ? 'and ended the session' : 'after the current round'}.`);
  d.debug(`${LOG} ticket ${d.key} stop ${when}`);
  if (when === 'now') await d.stopSession();
}
