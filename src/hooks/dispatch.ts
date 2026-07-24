import type { Store } from '../store/db.js';
import { setAgentState, setSessionId } from '../store/tickets.js';
import { ticketIdForWorktreePath } from '../runtime/worktree.js';
import type { AgentState } from '../model/types.js';

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
): void {
  if (!payload.cwd) return;
  const ticketId = ticketIdForWorktreePath(store, payload.cwd);
  if (ticketId === null) return;
  // Generation ownership guards every lifecycle mutation, including session_id.
  // Checking only before agent_state let a rejected stale SessionStart replace
  // the current conversation id even though its running state was ignored.
  if (shouldApplyState && !shouldApplyState(ticketId, payload)) return;

  // Persist the session on its first event so resume (§5.3) has a target. Only
  // SessionStart carries the authoritative id for a fresh session; later events
  // of the same session repeat it, so first-capture-wins is enough.
  if (payload.hook_event_name === 'SessionStart' && payload.session_id) {
    setSessionId(store, ticketId, payload.session_id);
  }

  const state = nextAgentState(payload);
  if (state === null) return;

  setAgentState(store, ticketId, state);
  notify?.(ticketId, payload);
}
