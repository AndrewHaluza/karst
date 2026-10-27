export type ReadinessStatus = 'ok' | 'warn' | 'fail';

export interface ReadinessItem {
  id: string;
  status: ReadinessStatus;
  detail: string;
  fix?: string;
}

export interface WorktreeTrial {
  ok: boolean;
  error?: string;
}

/** Machine facts `setup check` needs; injected so the checks run under fakes. */
export interface ReadinessProbes {
  isGitRepo(path: string): boolean;
  /** Local branch or `origin/<branch>`. */
  branchExists(repoPath: string, branch: string): boolean;
  hasRemote(repoPath: string, remote: string): boolean;
  remoteReachable(repoPath: string): Promise<boolean>;
  /** Add a detached worktree at the baseline under karst storage, remove it, verify the removal. */
  worktreeTrial(repoPath: string, branch: string): Promise<WorktreeTrial>;
  fileExists(repoPath: string, rel: string): boolean;
  baseDefinesScript(repoPath: string, branch: string, script: string): Promise<boolean>;
  binaryResolves(command: string): boolean;
  coreState(provider: string): 'ok' | 'missing' | 'not-ready';
}

export interface ReadinessReport {
  ok: boolean;
  items: ReadinessItem[];
}
