import type { Store } from '../store/db.js';
import { setAgentState, setSessionId } from '../store/tickets.js';
import { ticketIdForWorktreePath } from '../runtime/worktree.js';
import type { AgentState } from '../model/types.js';
import type { AgentProvider } from '../manifest/types.js';
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
  return {
    hook_event_name: o.hook_event_name as string | undefined,
    cwd: o.cwd as string | undefined,
    session_id: o.session_id as string | undefined,
    message: o.message as string | undefined,
    notification_type: o.notification_type as string | undefined,
  };
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
function nextAgentState(payload: HookPayload): AgentState | null {
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return 'running';
    case 'SessionEnd':
    case 'Stop':
      return 'idle';
    case 'session.idle':
      // opencode's normalized idle event (generated plugin, Task 7) — Stop
      // semantics: the session finished a turn.
      return 'idle';
    case 'permission.asked':
      // opencode's normalized permission prompt (generated plugin) — the amber
      // "Needs you" signal, equivalent to Claude's Notification/permission_prompt.
      return 'waiting';
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
      sessionProviderFor?.(ticketId) ?? null,
    );
  }

  const state = nextAgentState(payload);
  if (state === null) {
    observe('no-signal');
    return;
  }

  setAgentState(store, ticketId, state);
  observe('applied');
  notify?.(ticketId, payload);
}
