import type { Store } from '../store/db.js';
import { setAgentState } from '../store/tickets.js';
import { ticketIdForWorktreePath } from '../runtime/worktree.js';
import type { AgentState } from '../model/types.js';

/**
 * Claude Code hook payload (M0/T0.2 §143): JSON with `session_id`, `cwd`
 * (= worktree path), `hook_event_name`, plus event-specific fields. `message`
 * carries the Notification kind (`idle_prompt` / `permission_prompt`).
 */
export interface HookPayload {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  message?: string;
}

/** Called after a mutation so views (sidebar + dashboard) can refresh (§14). */
export type NotifyTicket = (ticketId: number) => void;

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
    !optStr(o.message)
  ) {
    return null;
  }
  return {
    hook_event_name: o.hook_event_name as string | undefined,
    cwd: o.cwd as string | undefined,
    session_id: o.session_id as string | undefined,
    message: o.message as string | undefined,
  };
}

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
    case 'Notification':
      // needs-you: the amber signal. Only these two kinds fire it (§5.6, T0.2).
      return payload.message === 'idle_prompt' || payload.message === 'permission_prompt'
        ? 'waiting'
        : null;
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
): void {
  if (!payload.cwd) return;
  const ticketId = ticketIdForWorktreePath(store, payload.cwd);
  if (ticketId === null) return;

  const state = nextAgentState(payload);
  if (state === null) return;

  setAgentState(store, ticketId, state);
  notify?.(ticketId);
}
