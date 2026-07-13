import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Manifest } from '../manifest/types.js';
import { worktreePaths, canonicalPath } from './worktree.js';

/**
 * A user-facing spin failure. Its `message` is safe to show verbatim (no command
 * dumps or stack traces) — the extension surfaces it directly in an error toast.
 */
export class SpinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpinError';
  }
}

/** Run a git subcommand in `cwd`; returns exit success (never throws). */
function gitOk(cwd: string, args: string[]): boolean {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/**
 * The worktree path a branch is checked out in, or `null` if the branch exists
 * but is not bound to any worktree (free to attach). Parses
 * `git worktree list --porcelain`, whose records pair a `worktree <path>` line
 * with a `branch refs/heads/<name>` line. Never throws.
 */
function checkedOutPath(repoPath: string, branch: string): string | null {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  if (r.error || r.status !== 0) return null;
  let currentPath: string | null = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) currentPath = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return currentPath;
  }
  return null;
}

/**
 * Validate the spin preconditions BEFORE any side effect (§7.2): every hot repo
 * is a real git repo and contains `baselineBranch`. Runs first in `spinTicket`,
 * so a wrong branch or bad path fails fast with a friendly `SpinError` instead of
 * a raw `git worktree add … fatal:` dump mid-spin (and creates nothing partial).
 *
 * Repo paths are deduped — a repo backing several hot services is checked once.
 * `slug` is the ticket's worktree slug (key-or-id + title); with a single slug
 * per ticket, two hot services sharing a repo map to the same path/branch, so
 * the target-check loop dedups by repoPath too.
 */
export function preflightSpin(manifest: Manifest, slug: string, hot: string[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const name of hot) {
    const svc = manifest.services[name];
    if (!svc) {
      problems.push(`service '${name}' is not in the manifest`);
      continue;
    }
    const repoPath = svc.repoPath;
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);

    // `--is-inside-work-tree` fails (nonzero / spawn error) for a non-git dir or
    // a path that doesn't exist — both surface as "not a git repository".
    if (!gitOk(repoPath, ['rev-parse', '--is-inside-work-tree'])) {
      problems.push(`${repoPath} is not a git repository`);
      continue;
    }

    // `<branch>^{commit}` verifies the ref resolves to a commit in this repo.
    const branch = manifest.baselineBranch;
    if (!gitOk(repoPath, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])) {
      problems.push(`branch '${branch}' not found in ${repoPath}`);
    }
  }

  // Per-service target checks (each hot service has its own slug → branch → path).
  // A leftover branch that's free to attach is fine — `createWorktree` reuses it,
  // and a worktree THIS ticket already owns (right path, right branch) is adopted
  // on retry, not a collision. Reject only the unrecoverable cases: our branch
  // checked out at a FOREIGN path, or the target path occupied by something that
  // isn't our worktree — either would make `git worktree add` fail mid-spin.
  const seenTargets = new Set<string>();
  for (const name of hot) {
    const svc = manifest.services[name];
    if (!svc) continue; // already reported above
    if (seenTargets.has(svc.repoPath)) continue; // one worktree per repo
    seenTargets.add(svc.repoPath);
    const { path, branch } = worktreePaths(svc.repoPath, slug);

    const boundTo = checkedOutPath(svc.repoPath, branch);
    if (boundTo !== null && canonicalPath(boundTo) === canonicalPath(path)) {
      // Our own worktree already sits here — a resumable spin. Not a problem.
      continue;
    }
    if (boundTo !== null) {
      problems.push(
        `branch '${branch}' is already checked out by another worktree in ${svc.repoPath} — tear that ticket down first`,
      );
    } else if (existsSync(path)) {
      problems.push(
        `worktree path ${path} already exists — tear the ticket down or remove it`,
      );
    }
  }

  if (problems.length > 0) {
    const bullets = problems.map((p) => `  • ${p}`).join('\n');
    throw new SpinError(
      `Cannot spin: ${problems.length} problem(s)\n${bullets}\n` +
        `Fix karst.yml (baselineBranch / repoPath) and try again.`,
    );
  }
}
