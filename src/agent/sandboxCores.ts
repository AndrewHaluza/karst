/** Which cores each sandbox backend can host (arch:AC-32). Dependency-free: the Settings webview imports it. */
export type SbxCore = 'claude' | 'codex';
export const SBX_CORES: readonly SbxCore[] = ['claude', 'codex'];

export type DockerCore = 'opencode' | 'opencode2' | 'antigravity' | 'agy';
export const DOCKER_CORES: readonly DockerCore[] = ['opencode', 'opencode2', 'antigravity', 'agy'] as const;
