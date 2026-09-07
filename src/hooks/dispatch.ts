import type { Store } from '../store/db.js';
import { setAgentState, setSessionId } from '../store/tickets.js';
import { ticketIdForWorktreePath } from '../runtime/worktree.js';
import type { AgentState } from '../model/types.js';
import type { AgentProvider } from '../manifest/types.js';
import { nowIso } from '../model/time.js';
import {
  confirmSessionLaunchIntent,
  getSessionLaunchIntent,
} from '../store/sessionLaunchIntents.js';
import {
  confirmFixLaunch,
  hasFixingRound,
  interruptActiveFixExecution,
} from '../store/recoveryRounds.js';
import {
  currentImplementationRun,
  interruptImplementationRun,
} from '../store/implementationRuns.js';
import { appendInteractiveUsageSample } from '../store/interactiveUsageSamples.js';
import { normalizeInteractiveUsage } from '../agent/interactiveUsage.js';
import { isKnownProvider } from '../agent/provider.js';
import type {
  HookChannelRecorder,
  HookDispatchOutcome,
} from '../diagnostics/hookChannel.js';

/**
 * Claude Code hook payload (M0/T0.2 §143): JSON with `session_id`, `cwd`
 * (= worktree path), `hook_event_name`, plus event-specific fields.
 *
 * The Notification kind lives in `notification_type` (`permission_prompt`,
 * `idle_prompt`, `agent_needs_input`, …) — a SYMBOLIC field. `message` is the
 * human-readable string Claude renders ("Claude needs your permission to use
 * Bash") and is NOT a stable identifier. Keying the amber signal off `message`
 * was the "Needs you" bug: a real permission prompt never matched, so it never
 * surfaced.
 */
export interface HookPayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  message?: string;
  notification_type?: string;
  /**
   * Task 5: the provider-supplied usage payload of a closed `UsageUpdate`
   * event. Untrusted until `normalizeInteractiveUsage` narrows it — the
   * boundary only checks that it is a plain object, never its values.
   */
  usage?: unknown;
  /** Endpoint-derived launch generation; never trusted from the JSON body. */
  launchId?: string;
}

/** Called after a mutation so views (sidebar + dashboard) can refresh (§14). */
export type NotifyTicket = (ticketId: number, payload: HookPayload) => void;
/**
 * The agent core a ticket resolves to right now (per-ticket override else the
 * manifest default). Supplied by the host because it owns the manifest; the
 * captured session is tagged with it so a later core switch can be detected.
 */
export type SessionProviderFor = (ticketId: number) => AgentProvider | null;
export type ShouldApplyHookState = (
  ticketId: number,
  payload: HookPayload,
) => boolean;

/**
 * Narrow untrusted JSON to a HookPayload — the hook body is external input, so
 * every field is validated as an optional string before it flows into a SQL
 * bind (a non-string `cwd` would otherwise throw inside better-sqlite3). Returns
 * null for anything that isn't a plain object of optional strings.
 */
export function parseHookPayload(raw: unknown): HookPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const optStr = (v: unknown): v is string | undefined =>
    v === undefined || typeof v === 'string';
  if (
    !optStr(o.hook_event_name) ||
    !optStr(o.cwd) ||
    !optStr(o.session_id) ||
    !optStr(o.message) ||
    !optStr(o.notification_type)
  ) {
    return null;
  }
  // `usage` is carried through UNVALIDATED — only its plain-objectness is
  // checked here. The numeric narrowing happens in `normalizeInteractiveUsage`
  // at dispatch time, so a bridge posting garbage values drops the usage
  // without ever putting a non-count into the store.
  const usage = o.usage;
  if (
    usage !== undefined &&
    (typeof usage !== 'object' || usage === null || Array.isArray(usage))
  ) {
    return null;
  }
  return {
    hook_event_name: o.hook_event_name as string | undefined,
    cwd: o.cwd as string | undefined,
    session_id: o.session_id as string | undefined,
    message: o.message as string | undefined,
    notification_type: o.notification_type as string | undefined,
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * Whether the ticket is inside agent work whose done marker has NOT fired.
 *
 * The two agent lanes each own the fact: an implementation run stays `running`
 * until `completeImplementationRun` (the `stage impl pass` marker) closes it,
 * and a recovery round reads `fixing` until its Fix execution completes. Both
 * are READS of the marker's own record — never an inference about what the
 * agent is doing — so a turn ending against either one is a turn that ended
 * without the completion karst was told to wait for.
 */
function doneMarkerPending(store: Store, ticketId: number): boolean {
  if (currentImplementationRun(store, ticketId)?.status === 'running') return true;
  return hasFixingRound(store, ticketId);
}

/**
 * The Notification kinds that mean "blocked on the user" — the amber signal.
 * A permission dialog, a 60s idle prompt, an agent/MCP input request. Kinds that
 * report a completed action (`auth_success`, `agent_completed`,
 * `elicitation_complete`) are deliberately absent: they need no answer.
 */
const WAITING_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'permission_prompt',
  'idle_prompt',
  'agent_needs_input',
  'elicitation_dialog',
]);

/**
 * Map a hook event to the ticket's next `agent_state`, or `null` for events
 * that carry no liveness signal. CRITICAL: this only ever touches `agent_state`
 * — a stage transition is NEVER inferred from a hook (the no-inference
 * guarantee, §5.4). `Stop` in particular leaves `stage_current` untouched.
 */
function nextAgentState(payload: HookPayload, markerPending: boolean): AgentState | null {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return 'running';
    case 'SessionEnd':
      // The terminal is gone. A closed session asks the user nothing, so it
      // never claims the amber signal — resuming is the board's job, not a
      // question waiting for an answer.
      return 'idle';
    case 'Stop':
    case 'session.idle':
      // The turn ended (`session.idle` is opencode's normalized equivalent).
      // A turn that ends while the stage's done marker is still pending ended
      // ON the user: the agent asked something in plain prose, which no
      // Notification kind describes, and the session is sitting at its prompt
      // waiting to be answered. Blue "in progress" claimed work was happening
      // when nothing was. A stage whose marker already fired is genuinely
      // finished and stays idle.
      return markerPending ? 'waiting' : 'idle';
    case 'permission.asked':
      // opencode's normalized permission prompt (generated plugin) — the amber
      // "Needs you" signal, equivalent to Claude's Notification/permission_prompt.
      return 'waiting';
    case 'permission.replied':
      // opencode's normalized permission/question RESOLUTION (generated
      // plugin). opencode has no PostToolUse or UserPromptSubmit, so the reply
      // is the ONLY "the wait ended" signal its plugin can send — without it a
      // single answered prompt left the ticket amber for the whole remaining
      // turn while the session kept processing (FIX-WRONG-STATUS).
      return 'running';
    case 'session.status':
      // opencode's processing signal (generated plugin posts the status type
      // as `message`): busy (and retry) mean the session is working again.
      // `idle` is deliberately null — session.idle already owns that flip.
      return payload.message === 'busy' || payload.message === 'retry' ? 'running' : null;
    case 'Notification': {
      // needs-you: the amber signal. The kind is in `notification_type`; older
      // payloads that only carried it in `message` (the pre-fix symbolic values)
      // still resolve, so no live session regresses.
      const kind = payload.notification_type ?? payload.message;
      return kind !== undefined && WAITING_NOTIFICATION_TYPES.has(kind) ? 'waiting' : null;
    }
    case 'UserPromptSubmit':
    case 'PostToolUse':
      // activity after a wait → back to running (flips amber off).
      return 'running';
    default:
      return null;
  }
}

/**
 * Ingest a closed UsageUpdate event (Task 5): resolve the worktree → ticket,
 * narrow the usage payload, and append the measured cumulative sample to the
 * provider session's ledger, attributed to the ticket's currently bound
 * process. A malformed payload or an unattributable session changes nothing.
 * Usage is not a liveness signal — no agent_state is written. Returns true only
 * when displayed spend changed, so the host can refresh usage surfaces without
 * treating baselines, duplicates, or rejected samples as lifecycle activity.
 */
function ingestUsageUpdate(
  store: Store,
  payload: HookPayload,
  sessionProviderFor?: SessionProviderFor,
  debug?: (msg: string) => void,
): boolean {
  if (!payload.session_id) {
    debug?.(`[usage] skipped: no session_id`);
    return false;
  }
  const ticketId = ticketIdForWorktreePath(store, payload.cwd!);
  if (ticketId === null) {
    debug?.(`[usage] skipped: unknown worktree ${payload.cwd}`);
    return false;
  }

  // Usage belongs to the provider SESSION that emitted it, not whichever
  // provider the ticket would launch if asked right now. Configured Fix
  // assignments can intentionally differ from that mutable ticket setting.
  // Prefer the captured active-session identity. Only legacy/unbound sessions
  // fall back to live config.
  const active = store.db
    .prepare('SELECT session_provider FROM tickets WHERE id = ? AND session_id = ?')
    .get(ticketId, payload.session_id) as { session_provider: string | null } | undefined;
  const durableProvider =
    active !== undefined && isKnownProvider(active.session_provider)
      ? active.session_provider
      : null;
  const provider = durableProvider ?? sessionProviderFor?.(ticketId);
  if (provider === undefined || provider === null) {
    debug?.(`[usage] ticket ${ticketId}: no provider (durable=${durableProvider}, fallback=${sessionProviderFor?.(ticketId)})`);
    return false;
  }
  const normalized = normalizeInteractiveUsage(payload.usage);
  if (normalized === null) {
    debug?.(`[usage] ticket ${ticketId}: malformed usage payload`);
    return false;
  }
  debug?.(`[usage] ticket ${ticketId}: provider=${provider}, session=${payload.session_id}, input=${normalized.input}, output=${normalized.output}`);
  const result = appendInteractiveUsageSample(store, {
    ticketId,
    sample: {
      ...normalized,
      provider,
      providerSessionId: payload.session_id,
      observedAt: nowIso(),
    },
  });
  debug?.(`[usage] ticket ${ticketId}: append result=${result.kind}`);
  return result.kind === 'recorded';
}

/**
 * Apply a hook event to the store: resolve `cwd → ticket`, patch `agent_state`
 * only, and fan out via `notify`. Unknown worktrees and no-signal events are
 * silently ignored so a stray hook never mutates an unrelated ticket or throws.
 */
export function dispatchHook(
  store: Store,
  payload: HookPayload,
  notify?: NotifyTicket,
  shouldApplyState?: ShouldApplyHookState,
  sessionProviderFor?: SessionProviderFor,
  recorder?: HookChannelRecorder,
  debug?: (msg: string) => void,
): void {
  // Observation only — a recorder defect may not change what a hook does.
  const observe = (outcome: HookDispatchOutcome): void => {
    try {
      recorder?.record(outcome, payload.hook_event_name);
    } catch {
      // Diagnostics are best-effort.
    }
  };
  if (!payload.cwd) {
    observe('unknown-worktree');
    return;
  }
  const ticketId = ticketIdForWorktreePath(store, payload.cwd);
  if (ticketId === null) {
    observe('unknown-worktree');
    return;
  }
  // Generation ownership guards every lifecycle mutation, including session_id.
  // Checking only before agent_state let a rejected stale SessionStart replace
  // the current conversation id even though its running state was ignored.
  if (shouldApplyState && !shouldApplyState(ticketId, payload)) {
    observe('stale-generation');
    return;
  }

  // Usage is not a lifecycle event: it rides the same URL-guarded, generation-
  // checked path, but it records spend and never touches session or liveness.
  // A newly recorded delta is fanned out so already-open usage surfaces re-read
  // the ledger; baselines, duplicates and rejected samples changed no displayed
  // spend and therefore notify nothing.
  if (payload.hook_event_name === 'UsageUpdate') {
    if (ingestUsageUpdate(store, payload, sessionProviderFor, debug)) {
      notify?.(ticketId, payload);
    }
    return;
  }

  // A prepared launch snapshots the provider that is ACTUALLY starting. It
  // may intentionally differ from the ticket's mutable interactive provider
  // (configured Fix assignments do this), so a matching launch intent is the
  // lifecycle authority for SessionStart. The host resolver remains the
  // fallback for starts outside the launch-intent handshake.
  const launchIntent =
    payload.hook_event_name === 'SessionStart' && payload.launchId !== undefined
      ? getSessionLaunchIntent(store, payload.launchId)
      : undefined;
  const lifecycleProvider =
    launchIntent?.ticketId === ticketId && isKnownProvider(launchIntent.provider)
      ? launchIntent.provider
      : (sessionProviderFor?.(ticketId) ?? null);

  // Persist the session on its first event so resume (§5.3) has a target. Only
  // SessionStart carries the authoritative id for a fresh session; later events
  // of the same session repeat it, so first-capture-wins is enough. The id is
  // tagged with the core that minted it — without that tag it is unusable, so a
  // missing resolver stores `null` and the session is simply never resumed.
  if (payload.hook_event_name === 'SessionStart' && payload.session_id) {
    setSessionId(
      store,
      ticketId,
      payload.session_id,
      lifecycleProvider,
    );
  }

  // The launch-intent handshake (v28): an accepted SessionStart carrying the
  // URL-authenticated launch id confirms the prepared launch and its segment.
  // The intent was persisted BEFORE the terminal existed, so a reload cannot
  // lose it; verification is the store's job (ticket, pending status, provider
  // — the lifecycle generation barrier above has already admitted the hook).
  // Every rejection is a no-op, and a session started outside karst (no
  // launch id, or one no launch ever recorded) changes nothing.
  if (payload.hook_event_name === 'SessionStart') {
    if (payload.launchId !== undefined && payload.session_id !== undefined) {
      // v30: a FIX launch confirms through `confirmFixLaunch`, which opens the
      // Fix process run and attaches it to the recovery round in the same
      // transaction — an implementation launch confirms through the plain
      // intent handshake (segment + stable run).
      const intent = launchIntent;
      if (intent !== undefined && intent.purpose === 'fix') {
        confirmFixLaunch(store, payload.launchId, {
          ticketId,
          provider: lifecycleProvider ?? '',
          providerSessionId: payload.session_id,
          at: nowIso(),
        });
      } else {
        confirmSessionLaunchIntent(store, payload.launchId, {
          ticketId,
          provider: lifecycleProvider ?? '',
          providerSessionId: payload.session_id,
          at: nowIso(),
        });
      }
    }
  } else if (payload.hook_event_name === 'SessionEnd') {
    // A session that ended WITHOUT the marker is an interrupted implementation:
    // the run and its segment close as interrupted, never passed — the marker
    // (`stage impl pass`) is the only completion authority, and a run the
    // marker already passed is left strictly alone. A FIX session that died
    // the same way interrupts its recovery execution: the Fix process run and
    // the round mark `interrupted`, never passed, and no additional round is
    // consumed.
    interruptImplementationRun(store, ticketId, nowIso());
    interruptActiveFixExecution(store, ticketId, nowIso());
  }

  // Read the marker BEFORE the SessionEnd branch above has a chance to matter:
  // `SessionEnd` never claims the amber signal anyway, and every other event
  // leaves the run untouched, so one read here serves the whole dispatch.
  const state = nextAgentState(payload, doneMarkerPending(store, ticketId));
  if (state === null) {
    observe('no-signal');
    return;
  }

  setAgentState(store, ticketId, state);
  observe('applied');
  notify?.(ticketId, payload);
}
