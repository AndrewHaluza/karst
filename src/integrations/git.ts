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
  /** Override the default per-call timeout (`GIT_TIMEOUT_MS`). */
  timeoutMs?: number;
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
/**
 * `pushBranch` gets its own, much longer budget: a push is network-bound (it
 * waits on the remote, not on local disk), so the generic 60s timeout for
 * local reads kills a real push well before a slow network or a large
 * branch finishes — production logs showed repeated
 * `git timed out after 60000ms: git push -u origin HEAD` failures.
 */
export const GIT_PUSH_TIMEOUT_MS = 600_000;
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
    options?.timeoutMs ?? GIT_TIMEOUT_MS,
    GIT_MAX_OUTPUT_BYTES,
    GIT_TERMINATION_GRACE_MS,
    options?.signal,
  );

/** `git <args>` in `cwd`, throwing git's own reason (never a bare colon) on failure. */
async function run(
  git: GitRunner,
  args: string[],
  cwd: string,
  what: string,
  options?: GitRunOptions,
): Promise<string> {
  const r = await git(args, cwd, options);
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
  // An unreachable remote is not a verdict (fu1). It used to read as "assume
  // changes", which ships a branch carrying none: the push then spends its whole
  // timeout on a remote that was already unreachable and fails the stage for a
  // repo the ticket never touched. The LOCAL base ref answers the same question
  // offline; only when nothing resolves does the old behavior stand — attempt
  // the PR and let GitHub decide.
  const fetched = await git(['fetch', 'origin', baseRef], cwd);
  let baseSpec = `origin/${baseRef}`;
  if (fetched.exitCode !== 0) {
    const localBase = await git(['rev-parse', '--verify', `${baseRef}^{commit}`], cwd);
    if (localBase.exitCode !== 0) return true;
    baseSpec = baseRef;
  }

  // Diff against the ticket's branch BY NAME when it is known: a worktree
  // checked out on the base branch (or a session in the main checkout) must
  // still read as changed when the ticket branch holds work — `...HEAD` there
  // reads empty and ship would silently open no PR (fu1). Absent a branch,
  // fall back to the checkout's HEAD.
  //
  // The LOCAL ref comes first and is the verdict. It is what this worktree
  // actually holds and what ship will push, including commits not pushed yet.
  // `origin/<branch>` is only a fallback for a branch with no usable local ref
  // (a probe in the main checkout after the worktree was removed) or a local
  // ref that lags the remote. It must never be the primary head: once a branch
  // has been merged into base with a merge commit, `origin/<branch>` is an
  // ancestor of base, so `base...origin/<branch>` reads empty even while the
  // local branch has moved on — that is exactly how ship came to report "no
  // changes from base" for a branch with new unpushed commits.
  const heads: string[] = [];
  if (branch && branch.trim() !== '') {
    const localRef = await git(['rev-parse', '--verify', `${branch}^{commit}`], cwd);
    if (localRef.exitCode === 0) heads.push(branch);
    const fetchedBranch = await git(['fetch', 'origin', branch], cwd);
    if (fetchedBranch.exitCode === 0) heads.push(`origin/${branch}`);
    // Neither ref resolves: keep the branch name so the diff reports the real
    // git failure instead of hiding it behind a false "no changes".
    if (heads.length === 0) heads.push(branch);
  } else {
    heads.push('HEAD');
  }

  for (const head of heads) {
    const result = await git(['diff', '--quiet', `${baseSpec}...${head}`], cwd);
    if (result.exitCode === 0) continue;
    if (result.exitCode === 1) return true;

    const reason = result.stderr.trim() || result.stdout.trim() || `git exit ${result.exitCode}`;
    throw new Error(`git diff failed in ${cwd}: ${reason}`);
  }
  return false;
}

/** An exact compare-and-swap for a force push: overwrite ONLY this value. */
export interface PushLease {
  /** The remote branch name (no `refs/heads/` prefix, no remote prefix). */
  ref: string;
  /** The sha the caller last saw at that ref. */
  expected: string;
}

export interface PushBranchOptions {
  /**
   * Force-push under a lease. Present only when karst itself rewrote the
   * branch (a base change rebase) — an ordinary push would be rejected as a
   * non-fast-forward.
   */
  forceWithLease?: PushLease;
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
 *
 * The lease is a compare-and-swap, never a bare `--force`: it names the exact
 * sha the caller last saw on the remote, so a teammate's push landing in the
 * gap REJECTS this one instead of being silently overwritten. A bare
 * `--force-with-lease` would trust this worktree's remote-tracking ref, which
 * may be stale; the explicit value is the whole point.
 */
export async function pushBranch(
  git: GitRunner,
  cwd: string,
  opts: PushBranchOptions = {},
): Promise<void> {
  const lease = opts.forceWithLease;
  const args = lease
    ? ['push', '-u', `--force-with-lease=${lease.ref}:${lease.expected}`, 'origin', 'HEAD']
    : ['push', '-u', 'origin', 'HEAD'];
  await run(git, args, cwd, 'push', { timeoutMs: GIT_PUSH_TIMEOUT_MS });
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
  /**
   * Git pathspecs (glob magic) the sweep commit must leave out. Applied to the
   * QUARANTINE index only: the live HEAD, index and worktree are untouched, and
   * an excluded path stays dirty in the worktree. Absent/empty means "stage the
   * whole worktree" — the pre-existing behavior.
   */
  exclude?: readonly string[];
}

/**
 * A user-authored exclude entry as an explicit glob pathspec. `:(glob)` is what
 * makes `**` cross directory separators (a bare `dist/**` under git's default
 * fnmatch does not), so the magic is added here and never written by the author
 * (`validateShip` refuses a leading `:`).
 */
function excludeGlobSpec(spec: string): string {
  return `:(glob)${spec}`;
}

/**
 * Paths changed in `range` (`git diff --name-only <range>`) that any exclude
 * spec matches. Empty when `specs` is empty — no git invocation. Throws on a
 * git failure so the caller decides; ship treats the answer as a warning.
 */
export async function changedPathsMatching(
  git: GitRunner,
  cwd: string,
  range: string,
  specs: readonly string[],
): Promise<string[]> {
  if (specs.length === 0) return [];
  const out = await git(['diff', '--name-only', range, '--', ...specs.map(excludeGlobSpec)], cwd);
  if (out.exitCode !== 0) {
    throw new Error(describeGitFailure(`git diff --name-only ${range}`, out));
  }
  // `--name-only` C-quotes a non-ASCII path just like `status` does; unquote so
  // the committed-match warning names the real path, not its octal form.
  return splitLines(out.stdout).map(unquotePorcelain);
}

/** Split git's newline-separated path output, dropping blank lines. */
function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** One `git status --porcelain` entry: the two status columns and the path. */
export interface PorcelainEntry {
  /** The two-character `XY` status (`??` for untracked, `R ` for a rename). */
  status: string;
  /** Worktree-relative path, C-quoted forms undone, the DESTINATION of a rename. */
  path: string;
  /**
   * The SOURCE path of a rename/copy (`R`/`C`), C-quoted forms undone; absent
   * for every other entry. A sweep commit's exclude reset can keep the
   * destination out while the source deletion still lands (`arch:SHIP-EXCLUDE`),
   * so a caller that models the commit needs both ends of the pair.
   */
  from?: string;
}

/**
 * Parse `git status --porcelain -uall` output into one entry per dirty path.
 * The DESTINATION of a rename/copy (`R  old -> new`) answers `path` and the
 * SOURCE answers `from` — a sweep commit records the destination, but an
 * exclude reset of that destination can leave the source deletion to commit
 * (`arch:SHIP-EXCLUDE`). C-quoted paths (`"a b"`, octal escapes) are undone. A
 * blank or short line is skipped rather than guessed at.
 *
 * Shared by ship's deny scan and the read-only ship preview so both read the
 * exact same dirty set from the exact same git output (`arch:SHIP-SECRET`).
 */
export function parsePorcelainEntries(porcelain: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    const arrow = renameSeparator(rest);
    const rawPath = arrow === -1 ? rest : rest.slice(arrow + 4);
    const path = unquotePorcelain(rawPath);
    if (path === '') continue;
    if (arrow === -1) {
      entries.push({ status, path });
    } else {
      const from = unquotePorcelain(rest.slice(0, arrow));
      entries.push(from === '' ? { status, path } : { status, path, from });
    }
  }
  return entries;
}

/**
 * The index of the ` -> ` separator in a rename/copy entry, or -1. The search
 * must respect git's quoting: a quoted path can itself contain ` -> `
 * (`"a -> b.txt"`), and a naive `lastIndexOf` splits inside the quotes and
 * returns a mangled path. The separator is always OUTSIDE the quotes, so scan
 * with a quote toggle (skipping backslash-escaped characters) and take the
 * first unquoted ` -> `.
 */
function renameSeparator(rest: string): number {
  let inQuotes = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === '\\') {
      i++; // the escaped character is literal; never a quote or separator
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && rest.startsWith(' -> ', i)) return i;
  }
  return -1;
}

/** The dirty paths of a `git status --porcelain -uall` read, in git's order. */
export function parsePorcelainPaths(porcelain: string): string[] {
  return parsePorcelainEntries(porcelain).map((entry) => entry.path);
}

/**
 * Undo git's C-style path quoting: `"`-wrapped, with the full C escape set
 * (`\\`, `\"`, `\a`, `\b`, `\t`, `\n`, `\v`, `\f`, `\r`) and octal BYTES. The
 * escapes are collected as raw bytes and decoded as UTF-8 — a per-escape
 * `String.fromCharCode` reads each UTF-8 byte as Latin-1 and turns `näme`
 * (quoted `n\303\244me`) into `nÃ¤me`.
 */
function unquotePorcelain(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0));
      continue;
    }
    const escape = body[i + 1];
    if (escape === undefined) {
      bytes.push(0x5c); // trailing backslash — literal
      break;
    }
    if (escape === '\\' || escape === '"') {
      bytes.push(escape.charCodeAt(0));
    } else if (escape === 'a') {
      bytes.push(0x07);
    } else if (escape === 'b') {
      bytes.push(0x08);
    } else if (escape === 't') {
      bytes.push(0x09);
    } else if (escape === 'n') {
      bytes.push(0x0a);
    } else if (escape === 'v') {
      bytes.push(0x0b);
    } else if (escape === 'f') {
      bytes.push(0x0c);
    } else if (escape === 'r') {
      bytes.push(0x0d);
    } else if (escape >= '0' && escape <= '7') {
      // A byte git wrote as 1–3 octal digits (UTF-8 continuation bytes included).
      let octal = escape;
      let j = i + 2;
      while (octal.length < 3 && j < body.length && body[j]! >= '0' && body[j]! <= '7') {
        octal += body[j];
        j++;
      }
      bytes.push(parseInt(octal, 8) & 0xff);
      i = j - 1;
      continue;
    } else {
      bytes.push(0x5c); // unknown escape — keep the backslash
    }
    i++;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The dirty paths (`git status --porcelain -uall`) that any exclude spec
 * matches — ship's read-only mirror of the QUARANTINE reset it later performs,
 * so the preview names exactly the paths the sweep commit will leave out. Empty
 * when `specs` is empty (no git invocation). Throws on a git failure so the
 * caller decides (the preview degrades the repo to an error).
 */
export async function dirtyPathsMatching(
  git: GitRunner,
  cwd: string,
  specs: readonly string[],
): Promise<string[]> {
  if (specs.length === 0) return [];
  const out = await git(
    ['status', '--porcelain', '-uall', '--', ...specs.map(excludeGlobSpec)],
    cwd,
  );
  if (out.exitCode !== 0) {
    throw new Error(describeGitFailure('git status --porcelain -uall -- <exclude>', out));
  }
  return parsePorcelainPaths(out.stdout);
}

/** The two object ids that authorize `created-by-ship` provenance. */
export interface PreparedCommit {
  intendedTree: string;
  /**
   * The commit to land, or `null` when excluding left the quarantine tree
   * identical to `preHead`'s — no commit was created (never an empty commit).
   */
  expectedHead: string | null;
  /** Worktree-relative paths the exclude specs kept out of the sweep commit. */
  excluded: string[];
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
  // Exclude: reset the QUARANTINE index entries the exclude specs name back to
  // `preHead`, so the sweep commit leaves them out. The live HEAD, live index and
  // worktree are untouched — excluded paths stay dirty in the worktree. The
  // `--cached` diff BEFORE the reset is what tells ship which dirty paths were
  // actually excluded (a spec matching nothing reports nothing).
  const specs = (input.exclude ?? []).map(excludeGlobSpec);
  let excluded: string[] = [];
  if (specs.length > 0) {
    const dirty = await runGitEnv(
      ['diff', '--cached', '--name-only', input.preHead, '--', ...specs],
      cwd,
      env,
    );
    if (dirty.exitCode !== 0) {
      throw new Error(`git diff --cached failed in ${cwd}: ${dirty.stderr.trim()}`);
    }
    excluded = splitLines(dirty.stdout);
    const reset = await runGitEnv(['reset', '-q', input.preHead, '--', ...specs], cwd, env);
    if (reset.exitCode !== 0) {
      throw new Error(`git reset failed in ${cwd}: ${reset.stderr.trim()}`);
    }
  }
  const tree = await runGitEnv(['write-tree'], cwd, env);
  if (tree.exitCode !== 0) {
    throw new Error(`git write-tree failed in ${cwd}: ${tree.stderr.trim()}`);
  }
  const intendedTree = tree.stdout.trim();

  // Excluding every dirty path leaves the tree identical to `preHead`'s: there
  // is nothing to commit, and an empty commit would be a lie. Only meaningful
  // once a spec was given — without one the caller expects a commit even for a
  // clean worktree (the review snapshot relies on that).
  if (specs.length > 0) {
    const preTree = await runGitEnv(['rev-parse', `${input.preHead}^{tree}`], cwd, env);
    if (preTree.exitCode === 0 && preTree.stdout.trim() === intendedTree) {
      return { intendedTree, expectedHead: null, excluded };
    }
  }

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
  return { intendedTree, expectedHead: commit.stdout.trim(), excluded };
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
