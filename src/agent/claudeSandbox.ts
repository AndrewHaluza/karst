/**
 * Claude Code's own OS sandbox (Seatbelt on macOS, bubblewrap on Linux) as one
 * `--settings` JSON value (`arch:AC-31`). Verified keys on claude 2.1.296:
 * `sandbox.enabled`, `failIfUnavailable` (refuse to start rather than run
 * uncontained — fail closed), `autoAllowBashIfSandboxed` (the relaxed prompts,
 * only inside the sandbox), `allowUnsandboxedCommands: false` (no escape hatch),
 * `filesystem.allowWrite`, `network.allowedDomains`. Edits inside the worktree
 * are accepted; nothing here bypasses permissions.
 */
import type { SandboxPolicy } from './sandbox.js';

/** `hookSettings` is the hook-channel settings file body, merged so ONE `--settings` carries both. */
export function claudeSandboxSettings(policy: SandboxPolicy, hookSettings?: string): string {
  const base = hookSettings ? (JSON.parse(hookSettings) as Record<string, unknown>) : {};
  return JSON.stringify({
    ...base,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { allowWrite: [...policy.writableRoots] },
      network: { allowedDomains: [...policy.allowedDomains] },
    },
    // Keep the base's rules (the process-kill deny) — only the mode is added.
    permissions: { ...(base.permissions as Record<string, unknown> | undefined), defaultMode: 'acceptEdits' },
  });
}
