import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { nodeEnvProbe } from '../../manifest/nodeEnvProbe.js';
import type { AgentProvider } from '../../manifest/types.js';
import { binaryResolves } from '../../doctor/probes.js';
import { runGit } from '../../integrations/git.js';
import { agentDependency, binaryExists, commandSucceeds, dependencyState, readCommandOutput } from '../../runtime/deps.js';
import { worktreePaths } from '../../runtime/worktree.js';
import { baseDefinesScript } from '../../workflow/gates/npmScript.js';
import type { ReadinessProbes, WorktreeTrial } from './types.js';

const exec = promisify(execFile);
const LS_REMOTE_TIMEOUT_MS = 10_000;
const WORKTREE_TIMEOUT_MS = 60_000;

const git = (repo: string, args: string[], timeout = WORKTREE_TIMEOUT_MS) =>
  exec('git', ['-C', repo, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

async function resolveRef(repo: string, branch: string): Promise<string | undefined> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      await git(repo, ['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function listsWorktree(repo: string, path: string): Promise<boolean> {
  const { stdout } = await git(repo, ['worktree', 'list', '--porcelain']);
  return stdout.split('\n').some((l) => l === `worktree ${path}`);
}

async function worktreeTrial(repo: string, branch: string): Promise<WorktreeTrial> {
  const ref = await resolveRef(repo, branch);
  if (ref === undefined) return { ok: false, error: `no ref for '${branch}'` };
  const { path } = worktreePaths(repo, `setup-check-${process.pid}`);
  let error: string | undefined;
  try {
    await git(repo, ['worktree', 'add', '--detach', path, ref]);
  } catch (e) {
    error = `worktree add: ${(e as Error).message}`;
  }
  try {
    await git(repo, ['worktree', 'remove', '--force', path]);
  } catch {
    /* verified below */
  }
  await git(repo, ['worktree', 'prune']).catch(() => undefined);
  if (existsSync(path) || (await listsWorktree(repo, path).catch(() => true))) {
    return { ok: false, error: error ?? `worktree not removed at ${path}` };
  }
  return error === undefined ? { ok: true } : { ok: false, error };
}

/** Real probes. `baseDir` resolves a relative `repoPath` (the manifest's directory). */
export function nodeReadinessProbes(baseDir: string = process.cwd()): ReadinessProbes {
  const env = nodeEnvProbe(baseDir);
  const at = (p: string): string => (isAbsolute(p) ? p : resolve(baseDir, p));
  return {
    isGitRepo: (p) => existsSync(join(at(p), '.git')),
    branchExists: (repo, branch) => env.branchExists(repo, branch),
    hasRemote: (repo, remote) => env.hasRemote(repo, remote),
    remoteReachable: async (repo) => {
      try {
        await git(at(repo), ['ls-remote', 'origin', 'HEAD'], LS_REMOTE_TIMEOUT_MS);
        return true;
      } catch {
        return false;
      }
    },
    worktreeTrial: (repo, branch) => worktreeTrial(at(repo), branch),
    fileExists: (repo, rel) => env.fileExists(repo, rel),
    baseDefinesScript: async (repo, branch, script) => {
      const ref = await resolveRef(at(repo), branch);
      const runner = (args: string[], cwd: string) => runGit(args, cwd);
      return ref !== undefined && baseDefinesScript(runner, at(repo), ref.replace(/^refs\/(heads\/|remotes\/)?/, ''), script);
    },
    binaryResolves,
    coreState: (provider) =>
      dependencyState(agentDependency(provider as AgentProvider), binaryExists, commandSucceeds, readCommandOutput),
  };
}
