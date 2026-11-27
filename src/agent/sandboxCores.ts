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

/**
 * Which cores an SSH remote can host in `mode: docker` (T1399/D822). The
 * sandbox image ships opencode v1 and v2 only: there is no claude or codex in
 * it, so neither can run in a REMOTE container (the local docker backend has
 * the same set minus agy, which stays host-bound, `@arch:AC-26`).
 */
export type SshDockerCore = 'opencode' | 'opencode2';
export const SSH_DOCKER_CORES: readonly SshDockerCore[] = ['opencode', 'opencode2'] as const;
