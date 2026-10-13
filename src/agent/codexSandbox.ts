/**
 * Codex's own OS sandbox (Seatbelt on macOS, Landlock on Linux) for an
 * interactive launch (`arch:AC-31`). `workspace-write` makes cwd (the ticket
 * worktree) writable; the other policy roots (the shared git dir, so commits
 * work) ride `writable_roots`. `on-request` keeps the model asking before it
 * leaves the sandbox — never `never`, never the bypass flag. Codex has no
 * per-domain allowlist, so network stays OFF: stricter than the policy's
 * allowlist, never wider.
 */
import type { SandboxPolicy } from './sandbox.js';

export function codexSandboxArgs(cwd: string, policy: SandboxPolicy): string[] {
  const extraRoots = policy.writableRoots.filter((root) => root !== cwd);
  return [
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'on-request',
    '--config',
    `sandbox_workspace_write.writable_roots=${JSON.stringify(extraRoots)}`,
    '--config',
    'sandbox_workspace_write.network_access=false',
  ];
}
