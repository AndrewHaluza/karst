import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BoundedOutput } from '../runtime/boundedOutput.js';
import { killTree } from '../runtime/processTree.js';
import { canonicalPath, isPathUnder } from '../runtime/pathScope.js';
import { collapseDiagnostic } from '../model/diagnosticText.js';

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
  stdoutTruncated?: boolean;
  stderr: string;
  exitCode: number;
}

export interface GitRunOptions {
  signal?: AbortSignal;
}

export type GitRunner = (
  args: string[],
  cwd: string,
  options?: GitRunOptions,
) => Promise<GitResult>;

export interface GitBytesResult {
  stdout: Buffer;
  stdoutTruncated: boolean;
  stderr: string;
  exitCode: number;
}

export type GitBytesRunner = (
  args: string[],
  cwd: string,
  options?: GitRunOptions,
) => Promise<GitBytesResult>;

/**
 * How long a single git invocation may take before it is killed and answered as a
 * failure. Ship fetches from a remote, so "hung" is a real state: an unreachable
 * host, or git blocking on a credential prompt with no tty to answer it.
 */
export const GIT_TIMEOUT_MS = 60_000;
export const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const GIT_TERMINATION_GRACE_MS = 5_000;

/**
 * `git <args>` in `cwd`, asynchronously. Never throws and never rejects — the exit
 * code is the answer, including for a spawn failure or a timeout.
 *
 * Async `spawn`, NOT `spawnSync`: this runs in the extension host, where the hook
 * endpoint, every webview and every other session share one event loop. A
 * synchronous spawn froze all of them for the duration of the call — tolerable
 * for local plumbing, indefensible once ship fetches from a remote.
 */
interface GitProcessResult {
  stdout: BoundedOutput;
  stderr: BoundedOutput;
  stderrDiagnostic: string;
  exitCode: number;
}

function runGitProcess(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
  maxOutputBytes: number = GIT_MAX_OUTPUT_BYTES,
  terminationGraceMs: number = GIT_TERMINATION_GRACE_MS,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<GitProcessResult> {
  return new Promise((resolve) => {
    const stdout = new BoundedOutput(Math.max(0, maxOutputBytes));
    const stderr = new BoundedOutput(Math.max(0, maxOutputBytes));
    let settled = false;
    let termination: 'abort' | 'timeout' | null = null;
    let terminationDiagnostic = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (exitCode: number, stderrDiagnostic = ''): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      signal?.removeEventListener('abort', abort);
      resolve({ stdout, stderr, stderrDiagnostic, exitCode });
    };

    const terminationReason = (unconfirmed: boolean): string => {
      const reason =
        termination === 'timeout'
          ? `git timed out after ${timeoutMs}ms`
          : 'git was aborted';
      return `${reason}${terminationDiagnostic}${
        unconfirmed ? '; child exit was not confirmed' : ''
      }: git ${args.join(' ')}`;
    };

    const terminate = (kind: 'abort' | 'timeout'): void => {
      if (settled || termination !== null) return;
      termination = kind;
      if (child?.pid === undefined) terminationDiagnostic = '; child pid unavailable';
      else killTree(child.pid);
      terminationTimer = setTimeout(
        () => settle(1, terminationReason(true)),
        Math.max(0, terminationGraceMs),
      );
    };

    const abort = (): void => terminate('abort');

    if (signal?.aborted) {
      termination = 'abort';
      settle(1, 'git was aborted before it started');
      return;
    }

    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn('git', args, { cwd, detached: true, env: { ...process.env, ...env } });
    } catch (err) {
      // A bad `cwd` throws synchronously on some platforms rather than emitting.
      settle(1, `could not run git: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => terminate('timeout'), Math.max(0, timeoutMs));

    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk));

    child.once('error', (err: Error) => {
      if (termination !== null) {
        terminationDiagnostic += `; termination error: ${err.message}`;
        return;
      }
      settle(1, `could not run git: ${err.message}`);
    });

    child.once('close', (code) => {
      if (termination !== null) {
        settle(1, terminationReason(false));
        return;
      }
      settle(code ?? 1);
    });
  });
}

function renderGitResult(result: GitProcessResult): GitResult {
  const renderedStderr = result.stderr.render(result.stderrDiagnostic);
  return {
    stdout: result.stdout.render(),
    stdoutTruncated: result.stdout.truncated,
    stderr:
      renderedStderr || (result.exitCode !== 0 ? `git exited ${result.exitCode}` : ''),
    exitCode: result.exitCode,
  };
}

export function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
  maxOutputBytes: number = GIT_MAX_OUTPUT_BYTES,
  terminationGraceMs: number = GIT_TERMINATION_GRACE_MS,
  signal?: AbortSignal,
): Promise<GitResult> {
  return runGitProcess(
    args,
    cwd,
    timeoutMs,
    maxOutputBytes,
    terminationGraceMs,
    signal,
  ).then(renderGitResult);
}

/**
 * `git <args>` with a modified environment, for commands whose behavior lives
 * in env: quarantine commit preparation (GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
 * GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_AUTHOR_* / GIT_COMMITTER_*) and the
 * HEAD/index compare-and-swap. The given env is layered OVER the process env.
 */
export function runGitEnv(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = GIT_TIMEOUT_MS,
  maxOutputBytes: number = GIT_MAX_OUTPUT_BYTES,
): Promise<GitResult> {
  return runGitProcess(
    args,
    cwd,
    timeoutMs,
    maxOutputBytes,
    GIT_TERMINATION_GRACE_MS,
    undefined,
    env,
  ).then(renderGitResult);
}

/** Byte-preserving bounded Git stdout for immutable content reads. */
export function runGitBytes(
  args: string[],
  cwd: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
  maxOutputBytes: number = GIT_MAX_OUTPUT_BYTES,
  terminationGraceMs: number = GIT_TERMINATION_GRACE_MS,
  signal?: AbortSignal,
): Promise<GitBytesResult> {
  return runGitProcess(
    args,
    cwd,
    timeoutMs,
    maxOutputBytes,
    terminationGraceMs,
    signal,
  ).then((result) => {
    const renderedStderr = result.stderr.render(result.stderrDiagnostic);
    return {
      stdout: result.stdout.toBuffer(),
      stdoutTruncated: result.stdout.truncated,
      stderr:
        renderedStderr || (result.exitCode !== 0 ? `git exited ${result.exitCode}` : ''),
      exitCode: result.exitCode,
    };
  });
}

/** Default runner: `git <args>` in `cwd`. Never throws — the exit code is the answer. */
export const defaultGitRunner: GitRunner = (args, cwd, options) =>
  runGit(
    args,
    cwd,
    GIT_TIMEOUT_MS,
    GIT_MAX_OUTPUT_BYTES,
    GIT_TERMINATION_GRACE_MS,
    options?.signal,
  );

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
  branch?: string | null,
): Promise<boolean> {
  // If the remote cannot be refreshed, preserve shipping's existing behavior:
  // attempt the PR and let GitHub decide. A failed optimization must not turn a
  // potentially valid ship into a new hard failure.
  const fetched = await git(['fetch', 'origin', baseRef], cwd);
  if (fetched.exitCode !== 0) return true;

  // Also fetch the feature branch so the diff head resolves against the remote
  // state — a local branch ref that is behind the remote produces an empty diff
  // even though the remote branch holds the ticket's actual work.
  let fetchedBranch: { exitCode: number } | null = null;
  if (branch && branch.trim() !== '') {
    fetchedBranch = await git(['fetch', 'origin', branch], cwd);
  }

  // Diff against the ticket's branch BY NAME when it is known: a worktree
  // checked out on the base branch (or a session in the main checkout) must
  // still read as changed when the ticket branch holds work — `...HEAD` there
  // reads empty and ship would silently open no PR (fu1). Absent a branch,
  // fall back to the checkout's HEAD.
  const head =
    branch && branch.trim() !== ''
      ? fetchedBranch && fetchedBranch.exitCode === 0
        ? `origin/${branch}`
        : branch
      : 'HEAD';
  const result = await git(['diff', '--quiet', `origin/${baseRef}...${head}`], cwd);
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

/**
 * Ship provenance primitives.
 *
 * The quarantine machinery exists so karst can prove, after a crash, that a
 * commit it finds on the branch was its own: preparation writes nothing into
 * the live index, refs, or main object database, and apply only ever installs
 * the EXACT object id the durable intent row recorded. `quarantineKey` is a
 * host-generated UUID, never a path — every derived path is checked for
 * canonical containment, and no cleanup accepts a stored or caller-supplied
 * path.
 */

/** The one directory beneath the repo git-dir that karst owns for preparation. */
export const QUARANTINE_DIR_NAME = 'karst-quarantine';
/** Lock file proving a compare-and-swap was started and whose index it meant to install. */
export const INDEX_LOCK_NAME = 'karst-index-lock';

const QUARANTINE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * The main object database path. In a LINKED worktree (every worktree karst
 * cuts), the per-worktree git dir is an admin dir that has NO `objects` — the
 * object db lives in the COMMON dir, named by the admin dir's `commondir` file
 * (relative, exactly as git reads it). A regular repo has no commondir file:
 * its git dir IS the common dir. Quarantine reads must alternate the common
 * object db — a per-worktree `join(gitDir, 'objects')` alternates a directory
 * that does not exist, so the base tree can never be unpacked (the failing
 * ship read-tree on 869efpayd).
 */
async function mainObjectsPath(
  git: GitRunner,
  cwd: string,
): Promise<string> {
  const gitDir = (await run(git, ['rev-parse', '--absolute-git-dir'], cwd, 'rev-parse')).trim();
  const commondirFile = join(gitDir, 'commondir');
  const commonDir = existsSync(commondirFile)
    ? resolve(gitDir, readFileSync(commondirFile, 'utf8').trim())
    : gitDir;
  return join(commonDir, 'objects');
}

/** Exact Git author/committer identity incl. the offset-bearing timestamp. */
export interface PersistedCommitIdentity {
  name: string;
  email: string;
  at: string;
}

export interface QuarantinePrepareInput {
  preHead: string;
  message: string;
  author: PersistedCommitIdentity;
  committer: PersistedCommitIdentity;
}

/** The two object ids that authorize `created-by-ship` provenance. */
export interface PreparedCommit {
  intendedTree: string;
  expectedHead: string;
}

export type CasOutcome =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'third-head'
        | 'index-diverged'
        | 'worktree-diverged'
        | 'quarantine-missing'
        | 'lock-exists'
        | 'install-failed';
    };

export interface CasInput {
  preHead: string;
  expectedHead: string;
  intendedTree: string;
  preIndexTree: string;
  expectedFingerprint: string;
  quarantineKey: string;
}

/**
 * Resolve and validate the quarantine directory for a key. Throws on a
 * non-key-shaped value; the returned path is guaranteed canonical and inside
 * `<git-dir>/karst-quarantine/`.
 */
async function quarantinePath(
  git: GitRunner,
  cwd: string,
  quarantineKey: string,
): Promise<string> {
  if (!QUARANTINE_KEY_PATTERN.test(quarantineKey)) {
    throw new Error(`invalid quarantine key ${JSON.stringify(quarantineKey)}`);
  }
  const gitDir = (await run(git, ['rev-parse', '--absolute-git-dir'], cwd, 'rev-parse')).trim();
  const root = join(canonicalPath(gitDir), QUARANTINE_DIR_NAME);
  const q = join(root, quarantineKey);
  if (!isPathUnder(q, root)) {
    throw new Error(`quarantine path escaped its root: ${q}`);
  }
  return q;
}

/**
 * Build the intended commit entirely inside the quarantine: a temporary index
 * from `preHead` + the staged worktree content, tree and commit objects written
 * into a quarantined object directory that alternates the main object db. The
 * live HEAD, live index, refs and main object db are untouched.
 */
export async function prepareCommitInQuarantine(
  git: GitRunner,
  cwd: string,
  quarantineKey: string,
  input: QuarantinePrepareInput,
): Promise<PreparedCommit> {
  const q = await quarantinePath(git, cwd, quarantineKey);
  const index = join(q, 'index');
  const objects = join(q, 'objects');
  mkdirSync(objects, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: index,
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: await mainObjectsPath(git, cwd),
  };

  const readTree = await runGitEnv(['read-tree', input.preHead], cwd, env);
  if (readTree.exitCode !== 0) {
    throw new Error(`git read-tree failed in ${cwd}: ${readTree.stderr.trim()}`);
  }
  const add = await runGitEnv(['add', '-A'], cwd, env);
  if (add.exitCode !== 0) {
    throw new Error(`git add failed in ${cwd}: ${add.stderr.trim()}`);
  }
  const tree = await runGitEnv(['write-tree'], cwd, env);
  if (tree.exitCode !== 0) {
    throw new Error(`git write-tree failed in ${cwd}: ${tree.stderr.trim()}`);
  }
  const intendedTree = tree.stdout.trim();

  const commitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_AUTHOR_NAME: input.author.name,
    GIT_AUTHOR_EMAIL: input.author.email,
    GIT_AUTHOR_DATE: input.author.at,
    GIT_COMMITTER_NAME: input.committer.name,
    GIT_COMMITTER_EMAIL: input.committer.email,
    GIT_COMMITTER_DATE: input.committer.at,
  };
  const commit = await runGitEnv(
    ['commit-tree', intendedTree, '-p', input.preHead, '-m', input.message],
    cwd,
    commitEnv,
  );
  if (commit.exitCode !== 0) {
    throw new Error(`git commit-tree failed in ${cwd}: ${commit.stderr.trim()}`);
  }
  return { intendedTree, expectedHead: commit.stdout.trim() };
}

/** Copy the quarantined objects into the main object database. Idempotent. */
export async function promoteQuarantinedObjects(
  git: GitRunner,
  cwd: string,
  quarantineKey: string,
): Promise<boolean> {
  const q = await quarantinePath(git, cwd, quarantineKey);
  const objects = join(q, 'objects');
  if (!existsSync(objects)) return false;
  const mainObjects = await mainObjectsPath(git, cwd);

  let promoted = false;
  const copyDir = (from: string, to: string): void => {
    for (const entry of readdirSync(from)) {
      const src = join(from, entry);
      const dst = join(to, entry);
      if (statSync(src).isDirectory()) {
        mkdirSync(dst, { recursive: true });
        copyDir(src, dst);
      } else {
        // Object files are content-addressed and read-only (0444): an existing
        // destination is byte-identical, and truncating a read-only file fails.
        if (existsSync(dst)) continue;
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        promoted = true;
      }
    }
  };
  copyDir(objects, mainObjects);
  return promoted;
}

/**
 * Atomically land the prepared commit: verify every precondition, take the
 * index lock (which names the intended tree so a crash mid-install stays
 * owned), compare-and-swap HEAD, install the intended index, release the lock.
 * Any divergence — including a lock that already exists — refuses without
 * touching HEAD or the index.
 */
export async function compareAndSwapHeadAndIndex(
  git: GitRunner,
  cwd: string,
  input: CasInput,
): Promise<CasOutcome> {
  const currentHead = await headCommit(git, cwd);
  if (currentHead !== input.preHead) return { ok: false, reason: 'third-head' };

  const index = await run(git, ['write-tree'], cwd, 'write-tree');
  if (index.trim() !== input.preIndexTree) return { ok: false, reason: 'index-diverged' };

  const summary = await workingTreeSummary(git, cwd);
  if (summary.fingerprint !== input.expectedFingerprint) {
    return { ok: false, reason: 'worktree-diverged' };
  }

  let q: string;
  try {
    q = await quarantinePath(git, cwd, input.quarantineKey);
  } catch {
    return { ok: false, reason: 'quarantine-missing' };
  }
  if (!existsSync(join(q, 'index')) || !existsSync(join(q, 'objects'))) {
    return { ok: false, reason: 'quarantine-missing' };
  }

  const gitDir = (await run(git, ['rev-parse', '--absolute-git-dir'], cwd, 'rev-parse')).trim();
  const lock = join(gitDir, INDEX_LOCK_NAME);
  if (existsSync(lock)) return { ok: false, reason: 'lock-exists' };
  writeFileSync(lock, input.intendedTree);

  try {
    const cas = await git(['update-ref', 'HEAD', input.expectedHead, input.preHead], cwd);
    if (cas.exitCode !== 0) {
      const after = await headCommit(git, cwd);
      if (after !== input.expectedHead && after !== input.preHead) {
        return { ok: false, reason: 'third-head' };
      }
      if (after !== input.expectedHead) return { ok: false, reason: 'install-failed' };
    }
    const install = await git(['read-tree', input.intendedTree], cwd);
    if (install.exitCode !== 0) return { ok: false, reason: 'install-failed' };
    return { ok: true };
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * A stable fingerprint of the worktree's tracked state plus untracked files
 * (plus HEAD): identical for an untouched worktree, different for any edit.
 */
export async function workingTreeSummary(
  git: GitRunner,
  cwd: string,
): Promise<{ fingerprint: string }> {
  const head = (await headCommit(git, cwd)) ?? '';
  const status = await run(git, ['status', '--porcelain'], cwd, 'status');
  const lines = status
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .sort();
  const fingerprint = createHash('sha256')
    .update([head, ...lines].join('\n'))
    .digest('hex')
    .slice(0, 40);
  return { fingerprint };
}

/**
 * One human sentence for a failed git invocation — the same bounded shape
 * `describeHeadlessFailure` gives a failed agent-CLI run. Git stderr is
 * unbounded CLI prose, so it is collapsed to one line and capped before it
 * reaches a stage verdict, a log line, or a rendered surface.
 */
export function describeGitFailure(
  what: string,
  result: Pick<GitResult, 'exitCode' | 'stderr' | 'stdout'>,
): string {
  const raw = result.stderr.trim() || result.stdout.trim();
  const detail = raw === '' ? 'no output' : collapseDiagnostic(raw);
  return `${what} failed (exit ${result.exitCode}): ${detail}`;
}

/** Commits reachable from HEAD but not from `sinceSha`, oldest first. Null = all. */
export async function listCommitsFrom(
  git: GitRunner,
  cwd: string,
  sinceSha: string | null,
): Promise<string[]> {
  const args = sinceSha
    ? ['rev-list', '--reverse', `${sinceSha}..HEAD`]
    : ['rev-list', '--reverse', 'HEAD'];
  const out = await git(args, cwd);
  if (out.exitCode !== 0) {
    throw new Error(
      describeGitFailure(`git rev-list ${sinceSha ? `${sinceSha}..HEAD` : 'HEAD'}`, out),
    );
  }
  return out.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** Current HEAD sha, or null when the repo has no commits. */
export async function headCommit(git: GitRunner, cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', 'HEAD'], cwd);
  if (r.exitCode !== 0) return null;
  const sha = r.stdout.trim();
  return sha || null;
}

/** The remote-tracking ref sha, or null when the ref does not exist locally. */
export async function remoteRefSha(
  git: GitRunner,
  cwd: string,
  remote: string,
  ref: string,
): Promise<string | null> {
  const r = await git(['rev-parse', '--verify', `refs/remotes/${remote}/${ref}`], cwd);
  if (r.exitCode !== 0) return null;
  const sha = r.stdout.trim();
  return sha || null;
}

/** Remove ONLY the canonically contained quarantine dir for the exact key. */
export async function cleanupQuarantine(
  git: GitRunner,
  cwd: string,
  quarantineKey: string,
): Promise<void> {
  const q = await quarantinePath(git, cwd, quarantineKey);
  rmSync(q, { recursive: true, force: true });
}
