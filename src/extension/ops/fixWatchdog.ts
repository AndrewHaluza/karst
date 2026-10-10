import type { Store } from '../../store/db.js';
import type { Manifest } from '../../manifest/types.js';
import type { AgentState, StageKey } from '../../model/types.js';
import { DEFAULT_FIX_STALL_TIMEOUT_MINUTES } from '../../manifest/types.js';
import {
  sweepStalledFixRounds,
  sweepAbandonedFixLaunches,
  describeStrandedFixRound,
} from '../../store/recoveryRounds.js';
import {
  selectDeliveryCandidates,
  type DeliveryCandidate,
  type DeliveryCheckOpts,
} from '../../store/sessionLaunchDelivery.js';
import {
  getSessionLaunchIntent,
  markTicketLaunchIntentsRedelivered,
} from '../../store/sessionLaunchIntents.js';
import { getTicket, setAgentState } from '../../store/tickets.js';
import { markerStageFor } from '../../agent/markerStage.js';
import { renderDoneMarkerInstruction, renderGateOnlyInstruction } from '../../agent/workflowCommand.js';
import { composeStageCommand } from '../../cli/stage.js';
import { composeContextCommand } from '../../cli/context.js';
import { karstCliRefs } from '../../agent/cliEnv.js';
import { isKnownProvider, providerConfirmsLaunch } from '../../agent/provider.js';
import { graphTicketSurface } from '../../approaches/graph/entryPoints.js';
import { fixBriefForTicket } from './fixBriefForTicket.js';
import { formatTicketRef } from '../../model/entityId.js';

export interface FixWatchdogDeps {
  store: Store;
  /** Minutes of no progress before a fix is parked. */
  timeoutMinutes: () => number;
  /**
   * The project whose configured window `timeoutMinutes` describes. The sweep
   * settles only this project's tickets, so one project's manifest window is
   * never applied to another project's fix. `null` (unbound) settles nothing.
   */
  projectId: () => number | null;
  now: () => string;
  log: (message: string) => void;
  /**
   * Whether a ticket's session terminal is live in THIS window (open, or a
   * revived/adopted handle). The delivery guard only re-sends a brief into a
   * live session; a ticket with no live session is marked needs-you instead.
   */
  isLive: (ticketId: number) => boolean;
  /**
   * Send a prompt into a ticket's live session, returning whether the nudge
   * reached one. The guard builds the brief + marker (`redeliveryPrompt`) and
   * owns WHEN; the host owns the send (`sessions.nudge`).
   */
  nudge: (ticketId: number, prompt: string) => boolean;
  /**
   * Whether the graph coordinator owns this ticket's session surface. A graph
   * ticket is never nudged by the guard (the coordinator owns continuation).
   */
  isGraphTicket: (ticketId: number) => boolean;
}

/**
 * The session-manager seams the delivery guard draws on: whether a ticket's
 * terminal is live in this window, and the blind send into it. Structural, so
 * this ops module never imports the vscode-adjacent `SessionManager`.
 */
export interface SessionDeliveryHost {
  isLive: (ticketId: number) => boolean;
  nudge: (ticketId: number, prompt: string) => boolean;
}

/**
 * Build the guard's delivery seams from the host's session manager and store:
 * liveness and the send live on the session manager, and "the graph coordinator
 * owns this ticket" is a store read. Kept here rather than in `extension.ts`
 * because the wiring is more than the thin binding that file's line ratchet
 * allows — and `extension.ts` passes only one argument for it.
 */
export function sessionDelivery(
  store: Store,
  sessions: SessionDeliveryHost,
): Pick<FixWatchdogDeps, 'isLive' | 'nudge' | 'isGraphTicket'> {
  return {
    isLive: (id) => sessions.isLive(id),
    nudge: (id, prompt) => sessions.nudge(id, prompt),
    isGraphTicket: (id) => graphTicketSurface(store.db, id) !== 'none',
  };
}

/**
 * The stall window for a ticket, in minutes: the larger of the two gate sections' configured
 * values, or `DEFAULT_FIX_STALL_TIMEOUT_MINUTES` when no manifest is loaded. The larger wins so
 * a project that runs long review fixes is never parked on the shorter uat window.
 */
export function stallTimeoutMinutes(manifest: Manifest | undefined): number {
  const uat = manifest?.uat?.stallTimeoutMinutes;
  const review = manifest?.review?.stallTimeoutMinutes;
  const configured = [uat, review].filter((n): n is number => typeof n === 'number' && n > 0);
  return configured.length === 0 ? DEFAULT_FIX_STALL_TIMEOUT_MINUTES : Math.max(...configured);
}

/** How often the watchdog ticks. */
export const FIX_WATCHDOG_INTERVAL_MS = 5 * 60_000;

/**
 * How long a prepared launch may stay `pending` before the delivery guard acts.
 * Deliberately much shorter than the stall window: a brief that never arrived
 * should be re-sent in ~90s, not ~60min. The 5-minute tick makes the effective
 * delay 90s..~6.5min, which is accepted rather than adding a second timer.
 *
 * 90s is safe for every core the guard ACTS on, because the intent is written
 * immediately before `createTerminal` and each such core's SessionStart is an
 * early lifecycle event:
 *   - claude   — a SessionStart hook fires on session start;
 *   - codex    — the generated bridge posts SessionStart on session start;
 *   - opencode — `session.created` (fresh) or, for a resume, right after the
 *                SDK kickoff is accepted (see `deliverResume`);
 *   - antigravity — the conversation-DB watch synthesizes SessionStart
 *                (`agyWatchLoop.ts`, ~10s poll);
 *   - headless — records no launch intent at all (a `run`, not a terminal).
 * The one core with NO confirmation path is opencode2 (no hook bridge yet, its
 * own ticket): it is EXEMPT via `providerConfirmsLaunch` rather than falsely
 * accused of never starting. No acting core can legitimately take 90s to emit
 * SessionStart.
 */
export const DELIVERY_CHECK_MS = 90_000;

/**
 * One watchdog tick, in two ordered halves:
 *
 *  1. DELIVERY GUARD (first): re-deliver every prepared launch whose brief never
 *     landed, then mark the ones that still cannot start needs-you. Runs BEFORE
 *     the park sweep so a launch inside its stall window is re-delivered, not
 *     parked.
 *  2. STALL PARK (second, final backstop): park every fix that has shown no
 *     progress past the timeout, and fail every fix launch that never confirmed
 *     before the stall window elapsed.
 */
export function runFixWatchdog(deps: FixWatchdogDeps): number {
  const minutes = deps.timeoutMinutes();
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  const timeoutMs = minutes * 60_000;
  const opts: DeliveryCheckOpts = {
    at: deps.now(),
    minAgeMs: DELIVERY_CHECK_MS,
    projectId: deps.projectId(),
  };
  runDeliveryGuard(deps, opts, timeoutMs);
  const stalled = {
    at: opts.at,
    timeoutMs,
    projectId: opts.projectId,
  };
  // Two holes, one window: a live fix run that stopped making progress, and a
  // fix LAUNCH that never started at all (its pending intent otherwise exempts
  // the ticket from the boot sweep's park forever).
  const settled = [
    ...sweepStalledFixRounds(deps.store, stalled),
    ...sweepAbandonedFixLaunches(deps.store, stalled),
  ];
  for (const s of settled) deps.log(describeStrandedFixRound(s));
  return settled.length;
}

/**
 * The delivery guard (v68): for every still-pending launch older than the
 * delivery window, re-send its brief ONCE into the live session; if there is no
 * live session (or a previous re-delivery still has not confirmed), mark the
 * ticket needs-you (`agent_state='not-started'`).
 *
 * One-shot by construction: the re-delivery stamps `redelivered_at` on EVERY
 * pending intent for the ticket, so the next tick sees the stamp and never
 * nudges a second time — a blind `terminal.sendText` cannot know the agent
 * already got the brief, so a second nudge would duplicate it into a working
 * agent. Marking needs-you is likewise idempotent (see `markNotStarted`).
 *
 * The decision is made ONCE PER TICKET, not per intent: a ticket can hold two
 * pending intents at once (a never-confirmed implementation launch that survived
 * into the fix stage, plus the fix launch) and both address one session.
 */
function runDeliveryGuard(
  deps: FixWatchdogDeps,
  opts: DeliveryCheckOpts,
  stallTimeoutMs: number,
): void {
  const stallCutoff = Date.parse(opts.at) - stallTimeoutMs;
  // Exempt cores with no SessionStart source up front: a pending intent that can
  // never confirm is not evidence of a lost brief (opencode2).
  const candidates = selectDeliveryCandidates(deps.store, opts).filter(
    (c) => isKnownProvider(c.provider) && providerConfirmsLaunch(c.provider),
  );
  // Decide ONCE per ticket (one live session per ticket, however many intents).
  const decided = new Set<number>();
  for (const c of candidates) {
    if (decided.has(c.ticketId)) continue;
    decided.add(c.ticketId);
    const list = candidates.filter((x) => x.ticketId === c.ticketId);
    try {
      deliverForTicket(deps, c.ticketId, list, opts.at, stallCutoff);
    } catch (err) {
      // A throwing host seam (e.g. a terminal closed between the liveness check
      // and the send) must never abort the remaining tickets NOR the park
      // backstop that runs after this guard. Report it and move on; the next
      // tick retries.
      deps.log(
        `karst: ticket ${c.ticketId}: launch re-delivery failed (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }
}

/** One ticket's delivery decision — nudge / needs-you / leave it — made once. */
function deliverForTicket(
  deps: FixWatchdogDeps,
  ticketId: number,
  list: readonly DeliveryCandidate[],
  at: string,
  stallCutoff: number,
): void {
  // The graph coordinator owns a graph ticket's sessions — never nudge one.
  if (deps.isGraphTicket(ticketId)) return;
  // A fix launch past the stall window is the park sweep's to settle THIS tick:
  // it fails the intent below, so nudging the session now would tell it to do
  // work for a launch karst is simultaneously declaring never started. Checked
  // at the TICKET level — the park is per launch, but the session is shared, so
  // an implementation candidate must not slip a nudge past it.
  if (list.some((c) => c.purpose === 'fix' && Date.parse(c.createdAt) < stallCutoff)) return;
  // Prefer a launch NOT yet re-delivered: a stale, already-re-delivered
  // implementation intent must not shadow a fresh launch's re-delivery — the
  // exact loss this guard exists to close.
  const fresh = list.find((c) => c.redeliveredAt === null);
  if (fresh === undefined) {
    // Every pending intent was already re-delivered and is STILL pending: the
    // brief never reached the agent, so nothing starts without a human.
    markNotStarted(deps, ticketId);
    return;
  }
  // A hook has already proven the session alive (the SessionStart confirmation
  // was dropped but a later event arrived): the brief landed, so re-sending it
  // would duplicate the brief — and its done-marker instruction — into an agent
  // that is already working or waiting on a question. `markNotStarted` leaves
  // such a live state alone for the same reason. Only `none` — no hook ever
  // fired — means the launch truly never started.
  if (ticketAgentState(deps, ticketId) !== 'none') return;
  if (!deps.isLive(ticketId)) {
    // No live terminal to deliver into.
    markNotStarted(deps, ticketId);
    return;
  }
  // Re-read the status right before sending: a confirm or supersede that landed
  // since the select must not receive a second brief.
  const intent = getSessionLaunchIntent(deps.store, fresh.launchId);
  if (intent === undefined || intent.status !== 'pending') return;
  if (!deps.nudge(ticketId, redeliveryPrompt(deps.store, ticketId))) {
    // The nudge did not reach a live session (a race, or the terminal died
    // between the liveness check and the send).
    markNotStarted(deps, ticketId);
    return;
  }
  // Stamp EVERY pending intent for the ticket: the one-shot limit is per
  // session, so the survivor of a two-intent ticket is never nudged again.
  markTicketLaunchIntentsRedelivered(deps.store, ticketId, at);
  deps.log(`karst: ticket ${ticketId}: launch brief re-delivered into the live session, still awaiting SessionStart (launch ${fresh.launchId})`);
}

/** The ticket's hook-driven liveness, defaulting to `none` (no hook ever fired). */
function ticketAgentState(deps: FixWatchdogDeps, ticketId: number): AgentState {
  return (getTicket(deps.store, ticketId).agentState ?? 'none') as AgentState;
}

function markNotStarted(deps: FixWatchdogDeps, ticketId: number): void {
  // ANY hook-driven state proves the session is alive even though its launch
  // intent never confirmed — the exact loss this guard targets, where a
  // SessionStart was dropped but later events still arrived. `running`
  // (working), `waiting` (asked a question) and `idle` (sitting at the prompt)
  // must never be overwritten with needs-you: overwriting `waiting` would erase
  // a live question's reason AND lift the marker refusal that protects a
  // waiting agent. `not-started` is this function's own idempotent guard. Only
  // `none` — no hook ever fired — means the launch truly never started.
  if (ticketAgentState(deps, ticketId) !== 'none') return;
  setAgentState(deps.store, ticketId, 'not-started');
  deps.log(`karst: ticket ${ticketId}: session did not start — the launch never confirmed; marked needs-you for a human`);
}

/**
 * The brief + done marker re-sent into a live session whose prepared launch
 * never confirmed. Reuses the SAME renderers the launch seed uses: the fix
 * brief for a fix ticket, and a context-pull pointer for an implementation
 * ticket (the seed's authored context is not stored, but `karst context`
 * re-derives it from live state — the same authority the seed cites).
 *
 * The marker command is composed with `"$KARST_*"` env refs, exactly as a
 * karst terminal session exports them; the prompt is typed into that session's
 * shell, which resolves the refs.
 */
export function redeliveryPrompt(store: Store, ticketId: number): string {
  const t = getTicket(store, ticketId);
  const label = formatTicketRef(ticketId, t.key);
  const stage = markerStageFor(t.stageCurrent as StageKey | null);
  const refs = karstCliRefs();
  const marker =
    stage === null
      ? renderGateOnlyInstruction()
      : renderDoneMarkerInstruction(
          composeStageCommand(refs.cli, refs.db, stage, refs.manifest),
          t.key || String(ticketId),
        );
  const brief =
    t.stageCurrent === 'fix'
      ? (fixBriefForTicket(store, ticketId, label) ??
        `A gate failed for ticket ${label}. Re-run the checks, fix what they report, and confirm they pass.`)
      : `Your launch brief did not reach you. Load ticket ${label}'s context by running \`${composeContextCommand(refs.cli, refs.db, refs.manifest)} ${label} --md\` and continue the work it describes.`;
  return `${brief}\n\n${marker}`;
}

/**
 * Start the watchdog's timer. Returns a disposable the host pushes onto its subscriptions. Each
 * tick runs the delivery guard, then both park sweeps over one window: stalled fix runs, and
 * abandoned fix launches that never started.
 *
 * The interval lives here rather than in `extension.ts` because that file is against its line
 * ratchet; the host's whole cost is one import and one positional `push(startFixWatchdog(...))`.
 *
 * The first tick runs IMMEDIATELY, which is what covers activation: unlike the boot sweep (which
 * runs before the manifest and project are resolvable), this is called once both getters exist, so
 * the project's own configured window is honored. A failed tick is reported through `onError`.
 */
export function startFixWatchdog(
  store: Store,
  manifest: () => Manifest | undefined,
  projectId: () => number | null,
  log: (message: string) => void,
  onError: ((message: string, err: unknown) => void) | undefined,
  delivery: Pick<FixWatchdogDeps, 'isLive' | 'nudge' | 'isGraphTicket'>,
): { dispose(): void } {
  const deps: FixWatchdogDeps = {
    store,
    timeoutMinutes: () => stallTimeoutMinutes(manifest()),
    projectId,
    now: () => new Date().toISOString(),
    log,
    isLive: delivery.isLive,
    nudge: delivery.nudge,
    isGraphTicket: delivery.isGraphTicket,
  };
  const tick = (): void => {
    try {
      runFixWatchdog(deps);
    } catch (err) {
      // A sweep must never take the timer down; the next tick retries — but the
      // failure is reported, never swallowed.
      onError?.('karst: fix stall watchdog tick failed', err);
    }
  };
  // Settle stalls at activation too, once. The boot sweep cannot do this: it
  // runs before the manifest and project are resolvable, so it could never
  // honor the project's configured window. This tick runs after the host's
  // getters exist, and on the interval thereafter.
  tick();
  const timer = setInterval(tick, FIX_WATCHDOG_INTERVAL_MS);
  return { dispose: () => clearInterval(timer) };
}
