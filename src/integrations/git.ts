import { spawn } from 'node:child_process';

/**
 * Git integration for the stages that talk to a remote. The runner is injected so
 * ship logic stays unit-testable without a real repo or network; the default
 * runner shells out to `git`, inheriting the user's credentials.
 *
 * Local git plumbing (worktree create/remove) lives in `runtime/worktree.ts` and
 * does not belong here: that code is spawn-and-forget with no remote in sight.
 */

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

/**
 * How long a single git invocation may take before it is killed and answered as a
 * failure. Ship fetches from a remote, so "hung" is a real state: an unreachable
 * host, or git blocking on a credential prompt with no tty to answer it.
 */
export const GIT_TIMEOUT_MS = 60_000;

/**
 * `git <args>` in `cwd`, asynchronously. Never throws and never rejects — the exit
 * code is the answer, including for a spawn failure or a timeout.
 *
 * Async `spawn`, NOT `spawnSync`: this runs in the extension host, where the hook
 * endpoint, every webview and every other session share one event loop. A
 * synchronous spawn froze all of them for the duration of the call — tolerable
 * for local plumbing, indefensible once ship fetches from a remote.
 */
export function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // Armed before the child exists so a spawn that never starts still settles.
    const timer = setTimeout(() => {
      child?.kill('SIGKILL');
      settle({
        stdout,
        stderr: `${stderr}git timed out after ${timeoutMs}ms: git ${args.join(' ')}`,
        exitCode: 1,
      });
    }, timeoutMs);

    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn('git', args, { cwd });
    } catch (err) {
      // A bad `cwd` throws synchronously on some platforms rather than emitting.
      settle({
        stdout: '',
        stderr: `could not run git: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 1,
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    child.once('error', (err: Error) => {
      settle({ stdout, stderr: `${stderr}could not run git: ${err.message}`, exitCode: 1 });
    });

    child.once('close', (code) => {
      const exitCode = code ?? 1;
      settle({
        stdout,
        stderr: stderr || (exitCode !== 0 ? `git exited ${exitCode}` : ''),
        exitCode,
      });
    });
  });
}

/** Default runner: `git <args>` in `cwd`. Never throws — the exit code is the answer. */
export const defaultGitRunner: GitRunner = (args, cwd) => runGit(args, cwd);

/** `git <args>` in `cwd`, throwing git's own reason (never a bare colon) on failure. */
async function run(git: GitRunner, args: string[], cwd: string, what: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.exitCode !== 0) {
    const reason = r.stderr.trim() || r.stdout.trim() || `git exit ${r.exitCode}`;
    throw new Error(`git ${what} failed in ${cwd}: ${reason}`);
  }
  return r.stdout;
}

/**
 * Commit whatever the agent left in the worktree, so the branch actually carries
 * the work. Returns whether anything was committed.
 *
 * Ship, not impl, owns this: a stage marker says the agent believes it is done,
 * not that it ran `git commit`. When it didn't, the branch has no commits and
 * `gh pr create` fails with "No commits between main and karst/…" — the work is
 * finished, reviewed, and unshippable. A clean tree is the normal case (the agent
 * committed its own work) and must not produce an empty commit.
 */
export async function commitAllIfDirty(
  git: GitRunner,
  cwd: string,
  message: string,
): Promise<boolean> {
  const status = await run(git, ['status', '--porcelain'], cwd, 'status');
  if (!status.trim()) return false;

  await run(git, ['add', '-A'], cwd, 'add');
  await run(git, ['commit', '-m', message], cwd, 'commit');
  return true;
}

/**
 * Whether HEAD has an effective file change from the target branch.
 *
 * `diff --quiet` deliberately checks the resulting tree, not merely whether the
 * branch contains commits: a commit/revert pair is just as much a no-op to a PR
 * as a branch with no commits at all. Exit 1 means differences; any higher exit
 * is a real git failure and must not be mistaken for "changes exist".
 */
export async function hasChangesFrom(
  git: GitRunner,
  cwd: string,
  baseRef: string,
): Promise<boolean> {
  // If the remote cannot be refreshed, preserve shipping's existing behavior:
  // attempt the PR and let GitHub decide. A failed optimization must not turn a
  // potentially valid ship into a new hard failure.
  const fetched = await git(['fetch', 'origin', baseRef], cwd);
  if (fetched.exitCode !== 0) return true;

  const result = await git(['diff', '--quiet', `origin/${baseRef}...HEAD`], cwd);
  if (result.exitCode === 0) return false;
  if (result.exitCode === 1) return true;

  const reason = result.stderr.trim() || result.stdout.trim() || `git exit ${result.exitCode}`;
  throw new Error(`git diff failed in ${cwd}: ${reason}`);
}

/**
 * Publish the worktree's branch so a PR can be opened from it.
 *
 * `HEAD` rather than the branch name: it is what the worktree is actually on,
 * where the stored name is what karst believed at creation. `-u` sets upstream,
 * which is what `gh pr create` reads to find the head branch.
 *
 * Re-running is safe — an already-pushed, unchanged branch exits 0 ("Everything
 * up-to-date").
 */
export async function pushBranch(git: GitRunner, cwd: string): Promise<void> {
  await run(git, ['push', '-u', 'origin', 'HEAD'], cwd, 'push');
}
