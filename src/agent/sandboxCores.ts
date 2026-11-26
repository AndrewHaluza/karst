/** Which cores each sandbox backend can host (arch:AC-32). Dependency-free: the Settings webview imports it. */
export type SbxCore = 'claude' | 'codex';
export const SBX_CORES: readonly SbxCore[] = ['claude', 'codex'];

export type DockerCore = 'opencode' | 'opencode2' | 'antigravity' | 'agy';
export const DOCKER_CORES: readonly DockerCore[] = ['opencode', 'opencode2', 'antigravity', 'agy'] as const;

/**
 * Which cores an SSH remote can host (T1387). `agy` is excluded: karst reads its
 * conversation DB on the host (@arch:AC-26), so the lifecycle signals cannot
 * cross the remote boundary.
 */
export type SshCore = 'claude' | 'codex' | 'opencode' | 'opencode2';
export const SSH_CORES: readonly SshCore[] = ['claude', 'codex', 'opencode', 'opencode2'] as const;
