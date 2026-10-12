/**
 * The ONE deny list for commands that kill processes an agent did NOT start.
 *
 * Incident 2026-10-12 23:05Z: the UAT Tester for T661 (opencode2,
 * opencode-go/mimo-v2.6-flash) spawned `claude`, then cleaned up with
 * `kill $SPID; pkill -f 'claude'`. `pkill -f` matches EVERY process whose
 * cmdline contains 'claude', system-wide — it SIGTERMed every live karst agent
 * session on the machine (tickets 661, 666, 667, 668 within 1.3s) and a
 * planning session (P17). A prompt rule alone is NOT enough: the cheap model
 * ignored its instructions. So every core's launch permission config carries
 * these commands as a hard DENY, in that core's own vocabulary — and
 * `processKillRule` states the rule the deny cannot teach.
 *
 * `kill <pid>` / `kill $!` stay ALLOWED: an agent may legitimately stop the
 * child it started. Only the process-WIDE forms are denied. A core that cannot
 * express a deny declares its reason on `AdapterSurfaces.processKillDeny`
 * (AC-08) instead of silently dropping it here.
 *
 * Pure text/JSON data: no store, no fs. Consumed by every adapter's launch
 * paths (interactive AND headless/planning) via `opencodeLaunchPermission` and
 * the claude deny flags.
 */

/**
 * The process-wide kill commands, in the shared vocabulary the ticket names.
 * `pkill *`/`killall *` match by NAME (or cmdline with `-f`); the `kill`
 * forms signal the whole process group (`-1`/`0` are not PIDs).
 */
export const PROCESS_WIDE_KILL_COMMANDS = [
  'pkill *',
  'killall *',
  'kill -9 -1',
  'kill -1',
  'kill -- -1',
  'kill 0',
] as const;

/** One denied command from {@link PROCESS_WIDE_KILL_COMMANDS}. */
export type ProcessWideKillCommand = (typeof PROCESS_WIDE_KILL_COMMANDS)[number];

/**
 * opencode / opencode2 `permission.bash` granular rules: a wildcard pattern →
 * `deny`. The object form is last-match-wins (`pkill -f claude` matches
 * `pkill *`), and `--auto` auto-approves `ask` but NEVER weakens `deny`
 * (opencode.ai/docs/permissions).
 */
export function opencodeProcessKillDeny(): Record<string, 'deny'> {
  return Object.fromEntries(
    PROCESS_WIDE_KILL_COMMANDS.map((command) => [command, 'deny' as const]),
  );
}

/**
 * claude `Bash(...)` deny rules — the shape both `permissions.deny` and
 * `--disallowedTools` accept. A trailing `*` matches any text (including the
 * bare command), and claude enforces a deny rule in EVERY permission mode,
 * including `bypassPermissions`
 * (docs.claude.com/en/docs/claude-code/permissions).
 */
export function claudeProcessKillDeny(): string[] {
  return PROCESS_WIDE_KILL_COMMANDS.map((command) => `Bash(${command})`);
}
