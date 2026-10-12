import { execFile } from 'node:child_process';
import type { TicketContext } from './ticketContext.js';

/**
 * Branch drift: "the ticket was planned against <sha>; the base has moved N
 * commits since", plus the commits that touch the files the ticket names.
 *
 * The compute is split in two so the extension host never blocks its event
 * loop: `computeDriftNotes` runs the git probes ASYNCHRONOUSLY and the render
 * consumes the finished map. The short-lived CLI (`computeDriftNotesSync`) and
 * the tests may still use a synchronous runner — they are not the host.
 */

type Debug = (msg: string) => void;
/** Synchronous git runner (the CLI — a short-lived process, not the host). */
export type DriftGitSync = (args: string[], cwd: string) => string;
/** Asynchronous git runner (the extension host — must never block its loop). */
export type DriftGitAsync = (args: string[], cwd: string) => Promise<string>;

/** The context slice drift needs: the worktrees, the planned base shas, the repos and the pointers. */
export type DriftContext = Pick<TicketContext, 'worktrees' | 'baseShas' | 'repos' | 'codePointers'>;

export function parseCodePointerPaths(rawPointers: string | null | undefined): string[] {
  if (!rawPointers) return [];
  const paths: string[] = [];
  for (const line of rawPointers.split('\n')) {
    const m = line.trim().match(/^- (\S+?)(?::\d+)? —/);
    if (m?.[1] && !paths.includes(m[1])) {
      paths.push(m[1]);
    }
  }
  return paths;
}

/** Worktrees are keyed by repoPath, base shas by manifest name: match through the repo list. */
export function sharedBaseSha(ctx: Pick<TicketContext, 'repos' | 'baseShas'>, worktreeRepo: string): string | undefined {
  const entry = ctx.repos.find((r) => r.repoPath === worktreeRepo && ctx.baseShas[r.name]);
  return entry ? ctx.baseShas[entry.name] : undefined;
}

/** A worktree's planned base sha: keyed by path OR resolved through the manifest name. */
function baseShaFor(ctx: DriftContext, worktreeRepo: string): string | undefined {
  return ctx.baseShas[worktreeRepo] ?? sharedBaseSha(ctx, worktreeRepo);
}

/** The common prefix every drift note starts with. */
function movedPrefix(baseSha: string, targetBase: string, count: number): string {
  return `Planned against ${baseSha.slice(0, 8)}; ${targetBase} has moved ${count} commit${count === 1 ? '' : 's'} since`;
}

/**
 * Synchronous per-worktree note. The CLI uses this (via `computeDriftNotesSync`);
 * the extension host uses `computeDriftNoteAsync` instead. `runGit` throws on
 * failure; a failure is fail-soft (debug + no note).
 */
export function computeDriftNote(
  worktreePath: string,
  baseSha: string | undefined,
  baseRef: string | null,
  codePointerPaths: string[],
  debug: Debug | undefined,
  runGit: DriftGitSync,
): string | undefined {
  if (!baseSha || !baseSha.trim()) return undefined;
  const targetBase = baseRef?.trim() || 'HEAD';
  try {
    const countOut = runGit(['rev-list', '--count', `${baseSha}..${targetBase}`], worktreePath).trim();
    const count = parseInt(countOut, 10);
    if (isNaN(count) || count <= 0) return undefined;

    const prefix = movedPrefix(baseSha, targetBase, count);
    if (codePointerPaths.length === 0) return prefix;

    const mOut = runGit(['rev-list', '--count', `${baseSha}..${targetBase}`, '--', ...codePointerPaths], worktreePath).trim();
    const mCount = parseInt(mOut, 10);
    if (isNaN(mCount) || mCount <= 0) return prefix;

    const commits = runGit(
      ['log', '-n', '5', '--format=%h %s', `${baseSha}..${targetBase}`, '--', ...codePointerPaths],
      worktreePath,
    )
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    return `${prefix}; ${mCount} touch files this ticket names: ${commits.join(', ')}`;
  } catch (e) {
    debug?.(`[context:drift] git failed for ${worktreePath}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Asynchronous per-worktree note — the same rules as `computeDriftNote`, awaited. */
async function computeDriftNoteAsync(
  worktreePath: string,
  baseSha: string | undefined,
  baseRef: string | null,
  codePointerPaths: string[],
  debug: Debug | undefined,
  runGit: DriftGitAsync,
): Promise<string | undefined> {
  if (!baseSha || !baseSha.trim()) return undefined;
  const targetBase = baseRef?.trim() || 'HEAD';
  try {
    const countOut = (await runGit(['rev-list', '--count', `${baseSha}..${targetBase}`], worktreePath)).trim();
    const count = parseInt(countOut, 10);
    if (isNaN(count) || count <= 0) return undefined;

    const prefix = movedPrefix(baseSha, targetBase, count);
    if (codePointerPaths.length === 0) return prefix;

    const mOut = (
      await runGit(['rev-list', '--count', `${baseSha}..${targetBase}`, '--', ...codePointerPaths], worktreePath)
    ).trim();
    const mCount = parseInt(mOut, 10);
    if (isNaN(mCount) || mCount <= 0) return prefix;

    const commits = (
      await runGit(['log', '-n', '5', '--format=%h %s', `${baseSha}..${targetBase}`, '--', ...codePointerPaths], worktreePath)
    )
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    return `${prefix}; ${mCount} touch files this ticket names: ${commits.join(', ')}`;
  } catch (e) {
    debug?.(`[context:drift] git failed for ${worktreePath}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** The host's default async runner: `git <args>` in `cwd`, rejecting on failure. Never blocks. */
const defaultAsyncGit: DriftGitAsync = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

/**
 * Per-worktree drift notes for the extension host: async git, fail-soft, keyed
 * by worktree path. A worktree whose note is undefined (no base sha, no moved
 * commits, or a git failure) is simply absent from the map, and the render then
 * emits no drift line for it.
 */
export async function computeDriftNotes(
  ctx: DriftContext,
  runGit: DriftGitAsync = defaultAsyncGit,
  debug?: Debug,
): Promise<Map<string, string>> {
  const pointers = parseCodePointerPaths(ctx.codePointers);
  const notes = new Map<string, string>();
  for (const w of ctx.worktrees) {
    const note = await computeDriftNoteAsync(w.path, baseShaFor(ctx, w.repo), w.baseRef, pointers, debug, runGit);
    if (note !== undefined) notes.set(w.path, note);
  }
  return notes;
}

/** The synchronous map for the short-lived CLI: the same rules over a blocking runner. */
export function computeDriftNotesSync(
  ctx: DriftContext,
  runGit: DriftGitSync,
  debug?: Debug,
): Map<string, string> {
  const pointers = parseCodePointerPaths(ctx.codePointers);
  const notes = new Map<string, string>();
  for (const w of ctx.worktrees) {
    const note = computeDriftNote(w.path, baseShaFor(ctx, w.repo), w.baseRef, pointers, debug, runGit);
    if (note !== undefined) notes.set(w.path, note);
  }
  return notes;
}
