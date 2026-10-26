import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { EnvProbe } from './validate/envWarnings.js';

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined; // absent or unreadable: reads as "not there"
  }
}

/**
 * The shared git dir of `repoPath`. Reads files only — the manifest loads on the
 * extension host, where a git subprocess would block the event loop. A linked
 * worktree's `.git` is a file pointing at its own gitdir, whose `commondir`
 * holds the refs and config.
 */
function commonGitDir(repoPath: string): string | undefined {
  const dotGit = join(repoPath, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return undefined;
  }
  const pointer = readText(dotGit)?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
  if (!pointer) return undefined;
  const gitDir = resolve(repoPath, pointer);
  const common = readText(join(gitDir, 'commondir'))?.trim();
  return common ? resolve(gitDir, common) : gitDir;
}

function refExists(gitDir: string, ref: string): boolean {
  if (existsSync(join(gitDir, ref))) return true;
  const packed = readText(join(gitDir, 'packed-refs')) ?? '';
  return packed.split('\n').some((line) => line.endsWith(` ${ref}`));
}

/** The real fs probe. `baseDir` resolves a relative `repoPath` (the manifest's directory). */
export function nodeEnvProbe(baseDir: string = process.cwd()): EnvProbe {
  const at = (p: string): string => (isAbsolute(p) ? p : resolve(baseDir, p));
  return {
    pathExists: (p) => existsSync(at(p)),
    branchExists: (repoPath, branch) => {
      const gitDir = commonGitDir(at(repoPath));
      return (
        gitDir !== undefined &&
        (refExists(gitDir, `refs/heads/${branch}`) || refExists(gitDir, `refs/remotes/origin/${branch}`))
      );
    },
    hasRemote: (repoPath, remote) => {
      const gitDir = commonGitDir(at(repoPath));
      const config = gitDir ? readText(join(gitDir, 'config')) : undefined;
      return config !== undefined && config.includes(`[remote "${remote}"]`);
    },
    fileExists: (repoPath, rel) => existsSync(join(at(repoPath), rel)),
  };
}
