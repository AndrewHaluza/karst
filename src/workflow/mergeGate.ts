import type { Store } from '../store/db.js';
import type { ProjectScope } from '../store/tickets.js';
import { getTicket, listTickets } from '../store/tickets.js';
import { listCurrentPrsByTicket } from '../store/prs.js';
import { listMergeChecksByTicket } from '../store/mergeChecks.js';
import { stageBlock, clearStageBlock } from '../store/stageBlocks.js';
import { getStage, setStage } from '../store/stages.js';
import { nowIso } from '../model/time.js';
import { transition } from './machine.js';

/**
 * The gate between "the PRs are open" and "the work has landed" (§11) — an
 * entry condition on `done`, not a stage a ticket sits in.
 *
 * `ship` used to pass straight to a standalone `merge` stage and from there to
 * `done`, so a ticket read Done — and pushed the provider's done status — only
 * once a human clicked past `merge`. That extra node bought nothing a plain
 * gate couldn't: it was a stage nothing ever RAN in, just a parking spot. Now
 * ship's own `passed` verdict is what tries to reach `done`, and this module
 * decides whether that attempt actually lands there or stays parked at `ship`.
 *
 * Everything here is a READ over state karst already keeps current — `prs.status`
 * (re-probed by `prSync`) and `merge_checks` (re-probed by `mergeSync`) — plus at
 * most one transition. It never runs git, never calls gh, and never merges
 * anything: landing a PR is irreversible and stays a human's click
 * (`workflow/mergePr.ts`). This only decides whether the landing already
 * happened.
 */

/**
 * Why a ticket's delivery is, or is not, fully landed.
 *
 * `nothing-to-merge` is a genuine pass, not an empty case: a ticket whose work
 * produced no diff in any repo (`ship` skips the push and opens no PR when there
 * are no changes from the base) has delivered everything it had, and holding it
 * short of done forever would be a lie in the other direction.
 *
 * `conflicted` is separated from `awaiting` because the user's next move differs:
 * one is "click Merge", the other is "resolve this first". Both park the ticket
 * and both read as needs-you; only the wording changes.
 */
/**
 * `closed` is separated for the same reason as `conflicted` — the user's next
 * move differs — but it is the only one of the three that can NEVER resolve on
 * its own: a closed PR does not become 'merged', so waiting on it is waiting
 * forever. That is the stuck ship stage this state exists to name: the user
 * either reopens the PR upstream or dismisses it (`store/prs.ts`'s `dismissPr`,
 * driven by `workflow/dismissPr.ts`), and only then does the gate get an answer.
 */
export type MergeGateState =
  | { kind: 'nothing-to-merge' }
  | { kind: 'merged'; repos: readonly string[] }
  | { kind: 'closed'; repos: readonly string[]; pending: readonly string[] }
  | { kind: 'conflicted'; repos: readonly string[]; pending: readonly string[] }
  | { kind: 'awaiting'; repos: readonly string[] };

/**
 * Read a ticket's landing state from the PR rows and the merge checks.
 *
 * Pure over the store, so the whole decision is testable against an in-memory DB
 * with no gh and no git. The two inputs are both current state by construction —
 * a stale `open` for a PR merged upstream is exactly what `prSync` exists to
 * correct — so this never has to date-check anything itself.
 *
 * Any PR status other than a literal `'merged'` counts as unmerged, including
 * `'unknown'` — the reading a degraded probe (a failed `gh pr view`, a missing
 * PR row) leaves behind. An unanswered lookup must never be read as a landed
 * PR, or a ticket could reach `done` while gh simply failed to say.
 */
export function mergeGateState(store: Store, ticketId: number): MergeGateState {
  // A dismissed PR is one a human declared will never land. Dropping it here —
  // rather than counting it as merged — keeps the two readings apart: nothing
  // downstream may say a dismissed PR was merged, and a ticket whose every PR
  // was dismissed reads `nothing-to-merge`, the same honest answer as a ticket
  // whose work produced no diff.
  const prs = listCurrentPrsByTicket(store, ticketId).filter((p) => p.dismissedAt === null);
  if (prs.length === 0) return { kind: 'nothing-to-merge' };

  const unmerged = prs.filter((p) => p.status !== 'merged').map((p) => p.repo);
  if (unmerged.length === 0) {
    return { kind: 'merged', repos: prs.map((p) => p.repo) };
  }

  // `listMergeChecksByTicket` already drops the repos whose PR has landed, so a
  // conflict verdict frozen at merge time can never be read back here as a
  // reason to hold a merged ticket open.
  //
  // A failed read (e.g. a degraded `merge_checks` table) must not sink the
  // landing decision — `recordMergeChecks` already tolerates the same failure
  // per repo when WRITING these rows, and this READ is no more entitled to
  // fail the gate. Falling back to "nothing conflicted is known" degrades to
  // `awaiting`, the same as a ticket that was never checked.
  let checks: ReturnType<typeof listMergeChecksByTicket> = [];
  try {
    checks = listMergeChecksByTicket(store, ticketId);
  } catch {
    checks = [];
  }
  // A closed PR is named before a conflict: a conflict is resolvable and a
  // closed PR is not, so the closed one is the news that decides what the user
  // has to do next.
  const closed = prs
    .filter((p) => p.status === 'closed')
    .map((p) => p.repo)
    .filter((repo) => unmerged.includes(repo));
  if (closed.length > 0) {
    return { kind: 'closed', repos: closed, pending: unmerged.filter((r) => !closed.includes(r)) };
  }

  const conflicted = checks
    .filter((c) => c.state === 'conflicted')
    .map((c) => c.repo)
    // A conflict is only news about a repo that still has to land. A stale row
    // for a repo with no open PR left is not this gate's business.
    .filter((repo) => unmerged.includes(repo));

  if (conflicted.length > 0) {
    return {
      kind: 'conflicted',
      repos: conflicted,
      pending: unmerged.filter((r) => !conflicted.includes(r)),
    };
  }
  return { kind: 'awaiting', repos: unmerged };
}

/** True when the state means every delivered PR has landed (or there was none). */
export function isLanded(state: MergeGateState): boolean {
  return state.kind === 'merged' || state.kind === 'nothing-to-merge';
}

/** The repos this state is still waiting on, for naming in a block reason. */
function unmergedRepos(state: MergeGateState): readonly string[] {
  switch (state.kind) {
    case 'closed':
    case 'conflicted':
      return [...state.repos, ...state.pending];
    case 'awaiting':
      return state.repos;
    case 'merged':
    case 'nothing-to-merge':
      return [];
  }
}

/**
 * A block reason naming the unmerged PR(s), so the gate never fails silently —
 * the dashboard's blocked banner and the rail both read `stages.blocked_reason`
 * verbatim.
 */
function describeAwaitingMerge(state: MergeGateState): string {
  const repos = unmergedRepos(state);
  const list = repos.join(', ');
  const conflictNote =
    state.kind === 'conflicted'
      ? ` (${state.repos.length === 1 ? 'a conflict' : 'conflicts'} in ${state.repos.join(', ')})`
      : '';
  if (state.kind === 'closed') {
    // Named as a dead end with the way out, because it IS one: nothing karst or
    // GitHub does on its own will move this PR to merged. The wording is the
    // whole escape hatch a user parked here has — the dashboard's blocked banner
    // and the rail print `stages.blocked_reason` verbatim.
    const list = state.repos.join(', ');
    const rest = state.pending.length > 0 ? ` Still waiting on ${state.pending.join(', ')}.` : '';
    return state.repos.length === 1
      ? `blocked: the pull request for "${list}" was closed without merging — reopen it, or dismiss it to finish the ticket without it.${rest}`
      : `blocked: pull requests for ${list} were closed without merging — reopen them, or dismiss them to finish the ticket without them.${rest}`;
  }
  return repos.length === 1
    ? `blocked: the pull request for "${list}" has changes and is not merged yet${conflictNote}.`
    : `blocked: pull requests for ${list} have changes and are not merged yet${conflictNote}.`;
}

/**
 * Stamp the parked-awaiting-merge state on the ship row: ship's own work is
 * done (`passed`, with `endedAt`), only the landing is pending.
 *
 * `endedAt` alongside `status: 'passed'` — without it the row reads as still
 * running to anything that derives a duration from `endedAt ?? startedAt` (or
 * reads a null `endedAt` as "in flight").
 */
function parkAwaitingMerge(store: Store, ticketId: number, state: MergeGateState): void {
  setStage(store, ticketId, 'ship', {
    status: 'passed',
    endedAt: nowIso(),
    blockedKind: 'awaiting-merge',
    blockedReason: describeAwaitingMerge(state),
    blockedAt: nowIso(),
  });
}

/**
 * Whether a ticket at `ship` has PROVABLY shipped but lost its `awaiting-merge`
 * block to a failed terminal write.
 *
 * The not-landed block write in `resolveShipLanding` is deliberately swallowed
 * (the PRs are already open), which leaves the ship row at the `running` ship
 * stamped when its saga started: the pass AND the block were one write, so a
 * failure of that write records neither. The durable proof it shipped is the
 * PASSED `ship_runs` row ship closes before its tail — a ticket merely pending
 * its first confirm click has a `pending` stage row and no completed run, and a
 * ship still executing (or crashed) has a `running` run. Both are excluded, so
 * only the lost-block case matches.
 */
function shippedWithoutBlock(store: Store, ticketId: number): boolean {
  if (getStage(store, ticketId, 'ship')?.status !== 'running') return false;
  const rows = store.db
    .prepare('SELECT status FROM ship_runs WHERE ticket_id = ?')
    .all(ticketId) as { status: string }[];
  return rows.some((r) => r.status === 'passed') && !rows.some((r) => r.status === 'running');
}

export interface ShipGateResult {
  /** True only when THIS call moved the ticket from `ship` to `done`. */
  advanced: boolean;
  state: MergeGateState;
}

/** One line naming where the landing decision went, for `[merge]` debug logs. */
function describeMergeState(state: MergeGateState): string {
  switch (state.kind) {
    case 'nothing-to-merge':
      return 'nothing-to-merge (no PRs)';
    case 'merged':
      return `merged: ${state.repos.join(', ')}`;
    case 'closed':
      return `closed-without-merge: ${state.repos.join(', ')} (pending: ${state.pending.join(', ')})`;
    case 'conflicted':
      return `conflicted: ${state.repos.join(', ')} (pending: ${state.pending.join(', ')})`;
    case 'awaiting':
      return `awaiting: ${state.repos.join(', ')}`;
  }
}

/**
 * Try to land a ticket right after ship's own work just finished (PRs opened,
 * or nothing to ship). Called ONLY from `stages/ship.ts`, guarded by the same
 * `atShip` read that gates ship's other tail writes — this is the one call site
 * entitled to say "ship's job just completed", which is what makes it safe to
 * trust `mergeGateState`'s `nothing-to-merge` reading here: anywhere else, a
 * ticket freshly parked at `ship` pending its FIRST confirm click would also
 * read `nothing-to-merge` (no PR exists yet) and wrongly look landed.
 */
export function resolveShipLanding(
  store: Store,
  ticketId: number,
  debug?: (message: string) => void,
): ShipGateResult {
  const state = mergeGateState(store, ticketId);
  if (isLanded(state)) {
    debug?.(
      `[merge] ticket ${ticketId}: ship's tail sees ${describeMergeState(state)} — transitioning to done`,
    );
    // Ship's own verdict. `shipTicket`'s tail (`stages/ship.ts`) calls this
    // straight after the PRs were opened, deliberately outside the try/catch
    // that parks ship as `failed` on any throw from that tail — so this half
    // stays UNGUARDED on purpose: a failure to RECORD ship's pass is real news
    // and must propagate, the same as it did before this gate existed (a bare
    // `transition(...)` with nothing wrapping it).
    transition(store, ticketId, 'ship', { kind: 'passed' }, () => {
      clearStageBlock(store, ticketId, 'ship');
    });
    return { advanced: true, state };
  }
  debug?.(
    `[merge] ticket ${ticketId}: ship's tail sees ${describeMergeState(state)} — parking at ship with an awaiting-merge block`,
  );
  try {
    // Bookkeeping over state that already exists (the PRs are open; that
    // irreversible part already succeeded) — never let a failure here escape
    // and be mistaken for ship itself failing. This mirrors the pre-gate
    // shape, where the tail was an unguarded `transition(...)` followed by a
    // swallowed `try { settleMergeStage(...) } catch {}`.
    //
    // If this throws and is swallowed, the ticket is left at `ship` with NO
    // block recorded — not "awaiting-merge", just unmarked, with the ship row
    // still reading `running` from the saga's start. `settleShipGate` recovers
    // exactly that state from the durable PASSED `ship_runs` row (see
    // `shippedWithoutBlock`), repairing the block on its next sweep; a
    // re-ship (the normal recovery path for a ship failure) re-establishes it
    // too. So the swallow no longer strands the ticket.
    parkAwaitingMerge(store, ticketId, state);
  } catch {
    // Swallowed deliberately — see comment above. The PRs are already open;
    // failing ship over a block-write failure would misreport a successful
    // ship as a failure.
  }
  return { advanced: false, state };
}

/**
 * Re-settle a ticket already parked at `ship` and blocked on the merge gate —
 * the per-repo Merge click (`mergePr.ts`) and the background PR sweep
 * (`settleShipGates`) both call this rather than `resolveShipLanding`, because
 * unlike ship's own runner they cannot otherwise tell a ticket that has never
 * shipped from one still waiting on a merge — both read `stageCurrent ===
 * 'ship'`. The recorded `awaiting-merge` block is the normal proof, and a
 * ticket parked pending its first confirm click (no block set) is left alone.
 * `shippedWithoutBlock` is the one exception: a shipped ticket whose terminal
 * block write failed is recognized from its passed ship run and has the block
 * repaired here rather than being refused forever.
 *
 * Idempotent and safe to call from anywhere: the landing can be observed from
 * three unrelated places (the merge click, the background PR sweep noticing a
 * teammate's merge, ship itself when there was nothing to merge), and none of
 * them should have to know about the other two.
 */
export function settleShipGate(
  store: Store,
  ticketId: number,
  debug?: (message: string) => void,
): ShipGateResult {
  const ticket = getTicket(store, ticketId);
  if (ticket.stageCurrent !== 'ship') {
    debug?.(
      `[merge] ticket ${ticketId}: settle skipped — ticket is at '${ticket.stageCurrent}', not 'ship'`,
    );
    return { advanced: false, state: mergeGateState(store, ticketId) };
  }
  const awaiting = stageBlock(store, ticketId, 'ship')?.kind === 'awaiting-merge';
  // The recovery case: ship completed (a passed ship run) but the terminal
  // block write was lost, so there is no block to key on. Without this the
  // sweep refused forever and the ticket never reached `done`.
  const recover = !awaiting && shippedWithoutBlock(store, ticketId);
  if (!awaiting && !recover) {
    debug?.(
      `[merge] ticket ${ticketId}: settle skipped — no awaiting-merge block (freshly parked at ship?)`,
    );
    return { advanced: false, state: mergeGateState(store, ticketId) };
  }

  const state = mergeGateState(store, ticketId);
  if (!isLanded(state)) {
    if (recover) {
      debug?.(
        `[merge] ticket ${ticketId}: shipped without an awaiting-merge block — repairing the block`,
      );
      // Re-establish the lost block so the dashboard shows the waiting state
      // and the ticket is the sweep's business from here on.
      parkAwaitingMerge(store, ticketId, state);
    }
    debug?.(
      `[merge] ticket ${ticketId}: settle sees ${describeMergeState(state)} — still waiting`,
    );
    return { advanced: false, state };
  }

  debug?.(
    `[merge] ticket ${ticketId}: settle sees ${describeMergeState(state)} — transitioning to done`,
  );
  transition(store, ticketId, 'ship', { kind: 'passed' }, () => {
    clearStageBlock(store, ticketId, 'ship');
  });
  return { advanced: true, state };
}

/**
 * Settle every ticket in scope that is parked at `ship`, blocked on the merge
 * gate, returning the ids that reached `done`.
 *
 * A scan rather than a callback threaded through `syncPrStatuses`: the sweep
 * already re-probes each PR, and a ticket can also land through a merge nobody
 * in this window performed. One ticket's failure never sinks the rest — the
 * same discipline the PR and merge sweeps follow.
 */
export function settleShipGates(
  store: Store,
  scope: ProjectScope = {},
  debug?: (message: string) => void,
): number[] {
  const advanced: number[] = [];
  for (const ticket of listTickets(store, scope)) {
    if (ticket.stageCurrent !== 'ship') continue;
    debug?.(`[merge] sweep: ticket ${ticket.id} is at 'ship' — settling`);
    try {
      if (settleShipGate(store, ticket.id, debug).advanced) advanced.push(ticket.id);
    } catch {
      continue;
    }
  }
  return advanced;
}
