import type { Store } from '../../store/db.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { getTicket } from '../../store/tickets.js';
import { getStage } from '../../store/stages.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { ciFailureState } from '../../workflow/ciFailure.js';
import { restoreAwaitingMergeBlock } from '../../workflow/mergeGate.js';
import { parseChecks } from '../../model/prChecks.js';
import {
  effectiveAutopilot, getAutopilotTicket, grantAutopilotExtra, refundAutopilotAttempt,
  setAutopilotPaused, setAutopilotStopAfter, setAutopilotStopped, stoppedReason, takeAutopilotAttempt,
  type AutopilotKind,
} from '../../store/autopilot.js';

/**
 * Autopilot (T973): runs the SAME host action a user clicks at ship, without the click:
 * a failed CI check on the manifest allowlist -> Send CI failure to agent. Host tickets only.
 *
 * Never auto: a merge conflict (D479), a sandboxed ticket (D482), push diverged, merge to base, a closed PR.
 * Every decision is a pure read of the store plus injected seams (`vscode`-free); a park writes a bulletin note, never a toast.
 */

/** What a fix action reports back. */
export type FixOutcome =
  | { readonly kind: 'sent' }
  /** This window lost the lease before the round started: nothing ran, nothing is parked. */
  | { readonly kind: 'lease-lost' }
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
  /** The ticket runs on the host. False for a sandboxed ticket and for a placement that cannot be read. */
  readonly isHostTicket: () => Promise<boolean>;
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

/** The park reason for a sandboxed ticket or an unknown placement. */
const SANDBOXED_REASON = 'auto-fix not run: sandboxed ticket';

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

interface Problem { readonly kind: 'ci'; readonly repo: string; readonly signature: string; readonly failing?: readonly string[] }

/** `wait` = CI status is not known yet (pending or unreadable): neither act nor clear a park. */
function findProblem(d: AutopilotDeps): Problem | 'wait' | null {
  const ci = ciFailureState(d.store, d.ticketId);
  if (!ci.available) return ci.reason === 'not-failing' && provenClean(d) ? null : 'wait';
  const names = ci.prs.flatMap((p) => p.failing.map((f) => f.name)).sort();
  return { kind: 'ci', repo: ci.prs[0]!.repo, signature: [...new Set(names)].join('\n'), failing: [...new Set(names)] };
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
  // Only a SHIPPED ticket (the awaiting-merge block) is worked: a ticket that waits for Confirm ship has no block, and its
  // stored CI result belongs to an older head. Push-diverged and every other foreign block need a person too.
  if (stageBlock(d.store, d.ticketId, 'ship')?.kind !== 'awaiting-merge') return { kind: 'idle' };
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
  const problem = findProblem(d);
  if (problem === 'wait') return { kind: 'nothing' };
  if (!problem) {
    // The problem is gone: a stale park block and stop reason must not stay.
    if (state.stoppedReason !== null) setAutopilotStopped(d.store, d.ticketId, null);
    clearParkBlock(d.store, d.ticketId);
    return { kind: 'nothing' };
  }
  if (cfg.ci.policy === 'ask') return { kind: 'ask', reason: 'ci policy is ask' };
  if (!allChecksAllowed(problem.failing ?? [], cfg.ci.checks)) {
    const reason = `auto-fix not run: ci check ${(problem.failing ?? []).find((n) => !cfg.ci.checks.includes(n)) ?? '(none)'} is not on the allowlist`;
    return park(d, 'ci', reason, 'a failing check is not on the autopilot allowlist; send the failure to the agent by hand.');
  }
  // A sandboxed ticket, or a placement that cannot be read, gets no round (D482): park, write a note, spend no attempt.
  if (!(await d.isHostTicket().catch(() => false))) {
    return park(d, 'ci', SANDBOXED_REASON, 'the ticket is sandboxed or its placement is unknown; autopilot runs host tickets only. Send the failure to the agent by hand.');
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

  const budget = takeAutopilotAttempt(d.store, d.ticketId, problem.repo, problem.kind, problem.signature, cfg.ci.maxAttempts);
  if (!budget.ok) {
    return park(d, problem.kind, stoppedReason(problem.kind, budget.used, budget.max), `the budget for ${problem.repo} is spent; approve one more attempt or fix it by hand.`);
  }
  // An action that throws reached no agent: it costs no attempt and parks with the error, like a failed fetch.
  const outcome: FixOutcome = await d.sendCiFailure()
    .catch((err: unknown): FixOutcome => ({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) }));
  if (outcome.kind === 'lease-lost') {
    // Another window owns the round now: give the attempt back and stay quiet.
    refundAutopilotAttempt(d.store, d.ticketId, problem.repo, problem.kind);
    return { kind: 'not-controller' };
  }
  if (outcome.kind === 'sent') {
    queuedNoted(d.store).clear();
    setAutopilotStopped(d.store, d.ticketId, null);
    clearParkBlock(d.store, d.ticketId);
    d.note(`Autopilot: ${problem.kind} round ${budget.used}/${budget.max}`, `${d.key}: ran Send CI failure to agent for ${problem.repo} (round ${budget.used}/${budget.max}).`);
    d.debug(`${LOG} ticket ${d.key} ${problem.kind} round ${budget.used}/${budget.max} armed for ${problem.repo}`);
    return { kind: 'armed', problem: problem.kind, used: budget.used, max: budget.max };
  }
  // A failed action reached no agent: it costs no attempt and is not retried.
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
  return park(d, problem.kind, `auto-fix stopped: ${problem.kind} could not run (${outcome.reason})`, `the action failed (${outcome.reason}); the ticket stays in ship and no attempt was used.`, true);
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
