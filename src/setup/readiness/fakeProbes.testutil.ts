import type { ReadinessProbes } from './types.js';

/** All-green probes; override one to make a check fail. */
export function fakeProbes(over: Partial<ReadinessProbes> = {}): ReadinessProbes {
  return {
    isGitRepo: () => true,
    branchExists: () => true,
    hasRemote: () => true,
    remoteReachable: async () => true,
    worktreeTrial: async () => ({ ok: true }),
    fileExists: () => true,
    baseDefinesScript: async () => true,
    binaryResolves: () => true,
    coreState: () => 'ok',
    ...over,
  };
}
