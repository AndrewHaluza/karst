import type { Store } from '../../store/db.js';
import type { AutopilotConfig } from '../../manifest/autopilot.js';
import { getTicket } from '../../store/tickets.js';
import { getStage } from '../../store/stages.js';
import { parkGateStage, stageBlock } from '../../store/stageBlocks.js';
import { listMergeChecksByTicket } from '../../store/mergeChecks.js';
import { clearOpenPrProbe } from '../../store/prs.js';
import { ciFailureState } from '../../workflow/ciFailure.js';
import { restoreAwaitingMergeBlock } from '../../workflow/mergeGate.js';
import { parseChecks } from '../../model/prChecks.js';
import {
  effectiveAutopilot, getAutopilotTicket, grantAutopilotExtra, refundAutopilotAttempt,
  setAutopilotPaused, setAutopilotStopAfter, setAutopilotStopped, stoppedReason, takeAutopilotAttempt,
  type AutopilotKind,
} from '../../store/autopilot.js';

/**
 * Autopilot (T973, T996): runs the SAME host action a user clicks at ship, without the click:
 * a failed CI check on the manifest allowlist -> Send CI failure to agent; a merge conflict with a known base head ->
 * Resolve conflicts (the resolved merge is delivered by karst behind the gates). Host tickets only.
 *
 * Never auto: a rebase on base, a sandboxed ticket (D482), push diverged, merge to base, a closed PR.
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
  /** The ticket ran an implementation graph: a hand-off to Implement would reach no agent. */
  readonly isGraphTicket: () => boolean;
  readonly sendCiFailure: () => Promise<FixOutcome>;
  /** The Resolve conflicts path for one repo (`resolveConflictRound`). */
  readonly sendConflict: (repo: string) => Promise<FixOutcome>;
  /** A conflict round is armed, or karst delivers its resolved merge now: no other round starts beside it. */
  readonly conflictRoundActive: () => boolean;
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
  | { readonly kind: 'cleared' };

const LOG = '[ship] autopilot';

/** The park reason for a sandboxed ticket or an unknown placement. */
const GRAPH_REASON = 'auto-fix not run: graph ticket';
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
    return { kind: 'parked', reason };
  }
  // Already parked with this reason: nothing changed, so the views are not refreshed again.
  return { kind: 'nothing' };
}

/** One failing PR and the signature (its failing check names) its budget counts against. */
interface BudgetTarget { readonly repo: string; readonly signature: string }

interface Problem { readonly kind: 'ci'; readonly repo: string; readonly signature: string; readonly targets: readonly BudgetTarget[]; readonly failing?: readonly string[]; readonly cutShort?: boolean }
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
  return { kind: 'ci', repo: first.repo, signature: own.join('\n'), targets, failing: all, cutShort };
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
  // Only a SHIPPED ticket (the awaiting-merge block) is worked: a ticket that waits for Confirm ship has no block, and its
  // stored CI result belongs to an older head. Push-diverged and every other foreign block need a person too.
  if (stageBlock(d.store, d.ticketId, 'ship')?.kind !== 'awaiting-merge') return { kind: 'idle' };
  if (!d.controls()) return { kind: 'not-controller' };
  if (d.sessionRunning() || ticket.agentState === 'running') return { kind: 'busy' };
  // The merge check stays 'conflicted' (and the CI rollup stays on the old head) until the resolved merge is pushed and
  // probed again, so no time cooldown can tell a round in progress from a new one: read the round state itself.
  if (d.conflictRoundActive()) {
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
  if (conflicted.length > 0) return runConflictRound(d, cfg, conflicted);
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
  if (!allChecksAllowed(problem.failing ?? [], cfg.ci.checks)) {
    const reason = `auto-fix not run: ci check ${(problem.failing ?? []).find((n) => !cfg.ci.checks.includes(n)) ?? '(none)'} is not on the allowlist`;
    return park(d, 'ci', reason, 'a failing check is not on the autopilot allowlist; send the failure to the agent by hand.');
  }
  // A sandboxed ticket, or a placement that cannot be read, gets no round (D482): park, write a note, spend no attempt.
  const placement = await placementPark(d, 'ci');
  if (placement) return placement;
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
  // An action that throws reached no agent: it costs no attempt and parks with the error, like a failed fetch.
  const outcome: FixOutcome = await d.sendCiFailure()
    .catch((err: unknown): FixOutcome => ({ kind: 'failed', reason: err instanceof Error ? err.message : String(err) }));
  return settleRound(d, { kind: problem.kind, repo: problem.repo, used: budget.used, max: budget.max, action: 'Send CI failure to agent', refundAll }, outcome);
}

/** A sandboxed or graph ticket gets no round (D482): park with a note and spend no attempt. Null when the ticket may run a round. */
async function placementPark(d: AutopilotDeps, kind: AutopilotKind): Promise<AutopilotResult | null> {
  const hand = kind === 'ci' ? 'Send the failure' : 'Resolve the conflict';
  if (d.isGraphTicket()) {
    return park(d, kind, GRAPH_REASON, `the ticket ran an implementation graph, so a hand-off to Implement would reach no agent. ${hand} by hand.`);
  }
  if (!(await d.isHostTicket().catch(() => false))) {
    return park(d, kind, SANDBOXED_REASON, `the ticket is sandboxed or its placement is unknown; autopilot runs host tickets only. ${hand}${kind === 'ci' ? ' to the agent' : ''} by hand.`);
  }
  return null;
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
    if (r.kind === 'conflicts') clearOpenPrProbe(d.store, d.ticketId, r.repo);
    queuedNoted(d.store).clear();
    setAutopilotStopped(d.store, d.ticketId, null);
    clearParkBlock(d.store, d.ticketId);
    d.note(`Autopilot: ${r.kind} round ${r.used}/${r.max}`, `${d.key}: ran ${r.action} for ${r.repo} (round ${r.used}/${r.max}).`);
    d.debug(`${LOG} ticket ${d.key} ${r.kind} round ${r.used}/${r.max} armed for ${r.repo}`);
    return { kind: 'armed', problem: r.kind, used: r.used, max: r.max };
  }
  // A failed action reached no agent: it costs no attempt and is not retried.
  r.refundAll();
  if (getTicket(d.store, d.ticketId).stageCurrent !== 'ship') {
    // The action already moved the ticket on (CI hand-off to Implement) but no session got the task. The ship row is not ours
    // to park, so pause autopilot (it stays quiet until a person sets the mode again) and leave a visible stop reason.
    const reason = `auto-fix paused: ${r.kind} session did not start (${outcome.reason})`;
    setAutopilotStopped(d.store, d.ticketId, reason);
    setAutopilotPaused(d.store, d.ticketId, reason);
    d.note(`Autopilot: ${reason}`, `${d.key}: the ${r.kind} round for ${r.repo} moved the ticket to Implement but no session started; no attempt was used. Start the agent by hand, then set the auto-fix mode again to resume.`);
    d.debug(`${LOG} ticket ${d.key} ${r.kind} left ship before the failure: ${outcome.reason}`);
    return { kind: 'parked', reason };
  }
  return park(d, r.kind, `auto-fix stopped: ${r.kind} could not run (${outcome.reason})`, `the action failed (${outcome.reason}); the ticket stays in ship and no attempt was used.`, true);
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
  const placement = await placementPark(d, 'conflicts');
  if (placement) return placement;
  if (d.concurrencyFull()) return queueWait(d, 'conflicts', known[0]!.repo, known[0]!.baseSha);

  let spent: { repo: string; used: number; max: number } | null = null;
  for (const target of known) {
    const b = takeAutopilotAttempt(d.store, d.ticketId, target.repo, 'conflicts', target.baseSha, cfg.conflicts.maxRounds);
    if (!b.ok) { spent ??= { repo: target.repo, used: b.used, max: b.max }; continue; }
    const refundAll = (): void => refundAutopilotAttempt(d.store, d.ticketId, target.repo, 'conflicts');
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
