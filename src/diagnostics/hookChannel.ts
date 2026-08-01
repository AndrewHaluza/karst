/**
 * Host-side observation of the hook channel.
 *
 * The agent only ever reports `hook exited with code 1` — the reason for the
 * non-2xx lives on THIS side of the socket (wrong port, stale launch id, body
 * over the cap, an unregistered `cwd`). Pairing the two is what makes a hook
 * report actionable, so the endpoint and the dispatcher record every request
 * outcome here and the diagnostic report reads the counters.
 *
 * This module imports nothing: `hooks/` depends on it, never the reverse, so the
 * reporting graph can read the snapshot without reaching a module that opens a
 * socket (`diagnostics/nonInterference.test.ts`).
 */

/** Transport-level outcomes, recorded by the endpoint. */
export const HOOK_REQUEST_OUTCOMES = [
  /** Body parsed and handed to the dispatcher. */
  'accepted',
  /** Not JSON, or not a plain object of optional strings — swallowed, 204. */
  'malformed-body',
  /** Wrong path or method — the sender is aimed at something else. */
  'not-found',
  /** Malformed target: a bad or repeated `karstLaunch`. */
  'bad-request',
  /** Body over the endpoint cap. */
  'too-large',
  /** The sender never finished the body inside the request deadline. */
  'timeout',
  /** The connection went away before the body arrived. */
  'aborted',
  /** The dispatcher threw — a real defect, not a malformed body. */
  'dispatch-failed',
] as const;

/** Routing outcomes, recorded by the dispatcher once a body is in hand. */
export const HOOK_DISPATCH_OUTCOMES = [
  /** `agent_state` was written for a ticket. */
  'applied',
  /** No `cwd`, or a `cwd` that maps to no registered worktree. */
  'unknown-worktree',
  /** A previous launch generation still posting after a relaunch. */
  'stale-generation',
  /** A known event that carries no liveness signal. */
  'no-signal',
] as const;

export type HookRequestOutcome = (typeof HOOK_REQUEST_OUTCOMES)[number];
export type HookDispatchOutcome = (typeof HOOK_DISPATCH_OUTCOMES)[number];
export type HookChannelOutcome = HookRequestOutcome | HookDispatchOutcome;

export interface HookChannelSnapshot {
  readonly total: number
  readonly outcomes: Readonly<Record<string, number>>
  readonly events: Readonly<Record<string, number>>
  readonly firstAt: string | null
  readonly lastAt: string | null
}

export interface HookChannelRecorder {
  record(outcome: HookChannelOutcome, event?: string): void
  snapshot(): HookChannelSnapshot
}

/**
 * Hook event names reaching the counters are agent-authored strings. They are
 * counted under a fixed vocabulary and everything else collapses to `other`, so
 * an unbounded name can never become a key in the report.
 */
const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  'SessionStart',
  'SessionEnd',
  'Stop',
  'Notification',
  'UserPromptSubmit',
  'PostToolUse',
  'PreToolUse',
  'PermissionRequest',
]);

export function normalizeHookEventName(value: string | undefined): string {
  if (value === undefined) return 'absent';
  return KNOWN_EVENTS.has(value) ? value : 'other';
}

/**
 * Counters for one activation. Nothing is persisted: a report describes the
 * window that is running, and a count carried across restarts would describe a
 * hook channel that no longer exists.
 */
export function createHookChannelRecorder(
  now: () => Date = () => new Date(),
): HookChannelRecorder {
  const outcomes: Record<string, number> = {};
  const events: Record<string, number> = {};
  let total = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  return {
    record(outcome, event): void {
      const at = now().toISOString();
      total += 1;
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      const name = normalizeHookEventName(event);
      events[name] = (events[name] ?? 0) + 1;
      firstAt ??= at;
      lastAt = at;
    },
    snapshot(): HookChannelSnapshot {
      return {
        total,
        outcomes: { ...outcomes },
        events: { ...events },
        firstAt,
        lastAt,
      };
    },
  };
}
