import type { RepositoryDef } from '../../manifest/types.js';
import type { ReadinessItem, ReadinessProbes } from './types.js';

const ok = (id: string, detail: string): ReadinessItem => ({ id, status: 'ok', detail });
const fail = (id: string, detail: string, fix: string): ReadinessItem => ({ id, status: 'fail', detail, fix });

/** Per-repo readiness: git repo, baseline, origin, reachability, worktree round trip. Each gate stops the checks that depend on it. */
export async function checkRepo(
  name: string,
  repo: RepositoryDef,
  baseline: string,
  p: ReadinessProbes,
): Promise<ReadinessItem[]> {
  const path = repo.repoPath;
  if (!p.isGitRepo(path)) {
    return [
      fail(
        `repo.git.${name}`,
        `${path} is not a git repo`,
        `propose: git -C ${path} init -b ${baseline} plus an initial commit (karst setup propose-change)`,
      ),
    ];
  }
  const out: ReadinessItem[] = [ok(`repo.git.${name}`, `${path} is a git repo`)];
  if (!p.branchExists(path, baseline)) {
    out.push(
      fail(
        `repo.baseline.${name}`,
        `baseline branch '${baseline}' not found in ${path}`,
        `create it (git -C ${path} branch ${baseline} <commit>) or set baselineBranch`,
      ),
    );
    return out;
  }
  out.push(ok(`repo.baseline.${name}`, `baseline branch '${baseline}' resolves`));
  if (!p.hasRemote(path, 'origin')) {
    out.push(fail(`repo.origin.${name}`, `no 'origin' remote in ${path}`, `git -C ${path} remote add origin <url> (ship push needs it)`));
  } else {
    out.push(ok(`repo.origin.${name}`, "'origin' remote exists"));
    out.push(
      (await p.remoteReachable(path))
        ? ok(`repo.remote.${name}`, 'origin is reachable')
        : fail(`repo.remote.${name}`, 'git ls-remote origin failed or timed out', 'check the origin URL, network and credentials'),
    );
  }
  const trial = await p.worktreeTrial(path, baseline);
  out.push(
    trial.ok
      ? ok(`repo.worktree.${name}`, 'a worktree from the baseline can be created and removed')
      : fail(
          `repo.worktree.${name}`,
          `worktree trial failed: ${trial.error ?? 'unknown'}`,
          `run: git -C ${path} worktree prune; free disk space or fix permissions under ${path}/.karst/worktrees`,
        ),
  );
  return out;
}
