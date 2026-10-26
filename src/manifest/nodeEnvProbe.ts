import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { EnvProbe } from './validate/envWarnings.js';

const GIT_TIMEOUT_MS = 5000;

function git(repoPath: string, args: string[]): boolean {
  try {
    execFileSync('git', ['-C', repoPath, ...args], { stdio: 'ignore', timeout: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false; // not a repo, no git, or the ref is absent: all read as "not there"
  }
}

/** The real fs + git probe. `baseDir` resolves a relative `repoPath` (the manifest's directory). */
export function nodeEnvProbe(baseDir: string = process.cwd()): EnvProbe {
  const at = (p: string): string => (isAbsolute(p) ? p : resolve(baseDir, p));
  return {
    pathExists: (p) => existsSync(at(p)),
    branchExists: (repoPath, branch) =>
      git(at(repoPath), ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) ||
      git(at(repoPath), ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]),
    hasRemote: (repoPath, remote) => git(at(repoPath), ['remote', 'get-url', remote]),
    fileExists: (repoPath, rel) => existsSync(join(at(repoPath), rel)),
  };
}
